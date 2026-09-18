import type { Env } from "./types.js";
import {
  PROVIDER_DIFF_BUDGETS,
  extractCitedPaths,
  packPullContext,
  type DiffFile,
  type PackOptions,
  type ProviderName,
} from "./diffPack.js";
import { filterRoastByPackedPaths, dropResolvedRepeats, parseFindingAccounting, stripHedgeCloser, filterUnverifiedAbsoluteClaims, dropIntentContradictingFixIts } from "./pathFilter.js";
import {
  buildPartialReviewNote,
  buildUserPrompt,
  ROAST_SYSTEM_PROMPT,
} from "./prompts.js";
import {
  extractModelText,
  isTruncatedRoastText,
  isUsableRoastText,
  logEmptyCompletionPayload,
} from "./responseText.js";
import type { PackCoverage, PriorFinding } from "./types.js";

export class RoastQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoastQuotaError";
  }
}

export class RoastError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoastError";
  }
}

/** @deprecated Use RoastQuotaError */
export const GeminiQuotaError = RoastQuotaError;
/** @deprecated Use RoastError */
export const GeminiError = RoastError;

export type RoastInput = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  files: DiffFile[];
  filesIncomplete: boolean;
  /** Latest prior bot roast body, if any (verified against current diff). */
  priorRoast?: string | null;
  /** Addressable findings from the prior roast (F1..Fn). */
  priorFindings?: PriorFinding[];
  /** SHA the prior roast reviewed; enables the "what changed" delta. */
  reviewedSha?: string | null;
  /** Files changed between reviewedSha and the current head. */
  deltaFiles?: DiffFile[];
  deltaCommits?: number;
  /** First-line subjects for commits in the delta range. */
  deltaCommitMessages?: string[];
  /** First-line subjects from the PR's commits (stated intent). */
  commitMessages?: string[];
};

type ProviderFailure = {
  provider: string;
  message: string;
  quotaLike: boolean;
};

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; thought?: boolean }>;
    };
    finishReason?: string;
  }>;
  error?: { message?: string; status?: string; code?: number };
}


interface OpenAIChatResponse {
  choices?: Array<{
    message?: { content?: string | null };
  }>;
  /** Present on OpenAI (and most compatible gateways) for cost auditing. */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; type?: string; code?: string | number };
}

function isQuotaLikeMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("high demand") ||
    lower.includes("resource_exhausted") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("quota") ||
    lower.includes("capacity") ||
    lower.includes("too many requests") ||
    lower.includes("overloaded") ||
    lower.includes("neurons") ||
    lower.includes("out of capacity") ||
    lower.includes("3040")
  );
}

function isPromptTooLargeMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("request too large") ||
    lower.includes("tokens per minute") ||
    lower.includes("tpm") ||
    lower.includes("context length") ||
    lower.includes("maximum context") ||
    lower.includes("too many tokens") ||
    lower.includes("prompt is too long") ||
    lower.includes("payload too large") ||
    lower.includes("3006")
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503;
}

function scaleBudget(options: PackOptions, factor: number): PackOptions {
  return {
    maxTotalChars: Math.max(2_000, Math.floor(options.maxTotalChars * factor)),
    maxPerFileChars: Math.max(400, Math.floor(options.maxPerFileChars * factor)),
    maxBodyChars: Math.max(200, Math.floor(options.maxBodyChars * factor)),
  };
}

function budgetForProvider(env: Env, provider: ProviderName): PackOptions {
  const defaults = PROVIDER_DIFF_BUDGETS[provider];
  const base: PackOptions = {
    maxTotalChars: defaults.maxTotalChars,
    maxPerFileChars: defaults.maxPerFileChars,
    maxBodyChars: defaults.maxBodyChars,
  };
  const override = Number.parseInt(env.MAX_DIFF_CHARS || "", 10);
  // MAX_DIFF_CHARS remains a global ceiling (useful for ops), not a raise above provider limits.
  if (Number.isFinite(override) && override > 0) {
    base.maxTotalChars = Math.min(base.maxTotalChars, Math.max(5_000, override));
  }
  return base;
}

/** Share of a provider budget reserved for the "changes since last review" diff. */
const DELTA_BUDGET_SHARE = 0.3;

type SplitBudget = { diff: PackOptions; delta: PackOptions | null };

/**
 * Carve the delta pack out of the *same* provider budget, so adding a delta
 * never pushes a free-tier prompt past its limit.
 */
function splitForDelta(budget: PackOptions, hasDelta: boolean): SplitBudget {
  if (!hasDelta) return { diff: budget, delta: null };
  const deltaTotal = Math.max(
    1_500,
    Math.round(budget.maxTotalChars * DELTA_BUDGET_SHARE),
  );
  return {
    diff: {
      ...budget,
      maxTotalChars: Math.max(2_000, budget.maxTotalChars - deltaTotal),
    },
    delta: {
      maxTotalChars: deltaTotal,
      maxPerFileChars: Math.max(800, Math.round(budget.maxPerFileChars * 0.8)),
      maxBodyChars: 200,
    },
  };
}

/** Files cited by the prior review get packed first in both the diff and delta. */
function priorityPathsFor(input: RoastInput): Set<string> {
  const paths = new Set(extractCitedPaths(input.priorRoast || ""));
  for (const finding of input.priorFindings ?? []) {
    if (finding.path) paths.add(finding.path);
  }
  return paths;
}

type PackedPrompt = {
  userPrompt: string;
  truncated: boolean;
  packedDiff: string;
  includedFilenames: string[];
  coverage: PackCoverage;
};

function buildPackedPrompt(input: RoastInput, budget: PackOptions): PackedPrompt {
  const priorityPaths = priorityPathsFor(input);
  const deltaFiles = input.deltaFiles ?? [];
  const { diff: diffBudget, delta: deltaBudgetOptions } = splitForDelta(
    budget,
    deltaFiles.length > 0,
  );

  const packed = packPullContext(
    input.files,
    input.body,
    diffBudget,
    input.filesIncomplete,
    priorityPaths,
  );

  const delta = deltaBudgetOptions
    ? packPullContext(deltaFiles, "", deltaBudgetOptions, false, priorityPaths)
    : null;

  return {
    truncated: packed.truncated,
    packedDiff: packed.diff,
    includedFilenames: packed.includedFilenames,
    coverage: {
      includedFiles: packed.includedFiles,
      totalFiles: packed.totalFiles,
      shownChars: packed.shownPatchChars,
      totalChars: packed.totalPatchChars,
    },
    userPrompt: buildUserPrompt({
      owner: input.owner,
      repo: input.repo,
      number: input.number,
      title: input.title,
      body: packed.body,
      author: input.author,
      diff: packed.diff,
      truncated: packed.truncated,
      includedFiles: packed.includedFiles,
      totalFiles: packed.totalFiles,
      partialFiles: packed.partialFiles,
      commitMessages: input.commitMessages,
      priorRoast: input.priorRoast,
      priorFindings: input.priorFindings,
      reviewedSha: input.reviewedSha,
      reviewDelta: delta
        ? {
            diff: delta.diff,
            commits: input.deltaCommits ?? 0,
            files: delta.includedFilenames,
            truncated: delta.truncated,
            commitMessages: input.deltaCommitMessages,
          }
        : null,
    }),
  };
}

function geminiModel(env: Env): string {
  return env.GEMINI_MODEL || "gemini-3.6-flash";
}

function groqModel(env: Env): string {
  return env.GROQ_MODEL || "openai/gpt-oss-20b";
}

function workersAiModel(env: Env): string {
  // Prefer instruct models that fill `content`/`response`. GLM often leaves
  // content null and only fills `reasoning` with planning notes.
  return env.WORKERS_AI_MODEL || "@cf/google/gemma-4-26b-a4b-it";
}

/** Paid provider base URL; override for any OpenAI-shaped gateway. */
function openaiBaseUrl(env: Env): string {
  const raw = (env.OPENAI_BASE_URL || "").trim() || "https://api.openai.com/v1";
  return raw.replace(/\/+$/, "");
}

/**
 * Which body field carries the output cap. OpenAI's reasoning models expect
 * `max_completion_tokens`; some compatible gateways still want `max_tokens`.
 */
function openaiMaxTokensField(
  env: Env,
): "max_tokens" | "max_completion_tokens" | "omit" {
  const raw = (env.OPENAI_MAX_TOKENS_FIELD || "").trim().toLowerCase();
  if (raw === "max_tokens" || raw === "omit") return raw;
  return "max_completion_tokens";
}

/** The paid provider runs only when both halves of its config are present. */
function isOpenAiEnabled(env: Env): boolean {
  return Boolean(env.OPENAI_API_KEY && env.OPENAI_MODEL);
}

/** Enablement rules, shared by the attempt builders and `enabledProviders`. */
const PROVIDER_ENABLED: Record<ProviderName, (env: Env) => boolean> = {
  openai: isOpenAiEnabled,
  gemini: (env) => Boolean(env.GEMINI_API_KEY),
  workersai: (env) => Boolean(env.AI),
  groq: (env) => Boolean(env.GROQ_API_KEY),
};

/** Provider priority: optional paid endpoint first, then the free tiers. */
export const PROVIDER_PRIORITY: readonly ProviderName[] = [
  "openai",
  "gemini",
  "workersai",
  "groq",
];

/** Providers this env can actually call, in priority order. */
export function enabledProviders(env: Env): ProviderName[] {
  return PROVIDER_PRIORITY.filter((name) => PROVIDER_ENABLED[name](env));
}

/**
 * A half-configured paid provider is a silent no-op, so say it out loud rather
 * than quietly reviewing with the free tier.
 */
export function providerConfigWarnings(env: Env): string[] {
  const warnings: string[] = [];
  if (env.OPENAI_API_KEY && !env.OPENAI_MODEL) {
    warnings.push(
      "OPENAI_API_KEY is set but OPENAI_MODEL is missing — paid provider skipped. Set OPENAI_MODEL (e.g. gpt-5.6-terra) or remove the key.",
    );
  }
  if (env.OPENAI_MODEL && !env.OPENAI_API_KEY) {
    warnings.push(
      "OPENAI_MODEL is set but OPENAI_API_KEY is missing — paid provider skipped.",
    );
  }
  return warnings;
}

export type RoastResult = {
  text: string;
  provider: ProviderName;
  model: string;
  /** How much of the PR this run actually saw (written to the footer). */
  coverage: PackCoverage;
};

async function callGemini(env: Env, userPrompt: string): Promise<string> {
  const model = geminiModel(env);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: ROAST_SYSTEM_PROMPT }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userPrompt }],
        },
      ],
      generationConfig: {
        temperature: 0.9,
        // Thinking tokens count against this cap; keep headroom for the roast body.
        maxOutputTokens: 8192,
        // Gemini 3.x defaults to MEDIUM thinking and can burn the whole budget
        // before finishing the markdown reply (finishReason MAX_TOKENS mid-bullet).
        thinkingConfig: {
          thinkingLevel: "minimal",
          thinkingBudget: 0,
        },
      },
    }),
  });

  const data = (await res.json()) as GeminiResponse;

  if (!res.ok) {
    const message = data.error?.message || `Gemini HTTP ${res.status}`;
    const quotaLike =
      isRetryableStatus(res.status) ||
      data.error?.status === "RESOURCE_EXHAUSTED" ||
      isQuotaLikeMessage(message);
    throw Object.assign(new Error(message), {
      quotaLike,
      tooLarge: isPromptTooLargeMessage(message),
      emptyCompletion: false,
    });
  }

  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    .filter((p) => !p.thought)
    .map((p) => p.text || "")
    .join("")
    .trim();

  const finishReason = candidate?.finishReason || "";
  const truncatedByApi = /MAX_TOKENS/i.test(finishReason);
  if (
    !text ||
    !isUsableRoastText(text) ||
    truncatedByApi ||
    isTruncatedRoastText(text)
  ) {
    logEmptyCompletionPayload("Gemini", data);
    throw Object.assign(
      new Error(
        truncatedByApi || isTruncatedRoastText(text)
          ? "Gemini returned a truncated roast."
          : "Gemini returned an empty roast.",
      ),
      { quotaLike: false, tooLarge: false, emptyCompletion: true },
    );
  }

  return text;
}

/** Paid runs should be auditable: log token spend whenever a provider reports it. */
function logOpenAiUsage(provider: string, data: OpenAIChatResponse): void {
  const usage = data.usage;
  if (!usage) return;
  const parts = [
    typeof usage.prompt_tokens === "number"
      ? `prompt=${usage.prompt_tokens}`
      : null,
    typeof usage.completion_tokens === "number"
      ? `completion=${usage.completion_tokens}`
      : null,
    typeof usage.total_tokens === "number" ? `total=${usage.total_tokens}` : null,
  ].filter((part): part is string => Boolean(part));
  if (parts.length > 0) {
    console.error(`Roast ${provider} usage: ${parts.join(" ")} tokens`);
  }
}

export async function callOpenAICompatible(options: {
  provider: string;
  url: string;
  apiKey: string;
  model: string;
  userPrompt: string;
  maxTokens?: number;
  /**
   * Which body field carries the output cap. Defaults to `max_tokens` (Groq);
   * OpenAI's reasoning models expect `max_completion_tokens`.
   */
  maxTokensField?: "max_tokens" | "max_completion_tokens" | "omit";
  /** Reasoning models reject a non-default temperature, so the paid path omits it. */
  omitTemperature?: boolean;
  extraHeaders?: Record<string, string>;
  /** Extra OpenAI-compatible body fields (e.g. Groq reasoning controls). */
  extraBody?: Record<string, unknown>;
}): Promise<string> {
  const maxTokensField = options.maxTokensField ?? "max_tokens";
  const tokenCap =
    maxTokensField === "omit"
      ? {}
      : { [maxTokensField]: options.maxTokens ?? 2048 };

  const res = await fetch(options.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
      ...options.extraHeaders,
    },
    body: JSON.stringify({
      model: options.model,
      ...(options.omitTemperature ? {} : { temperature: 0.9 }),
      ...tokenCap,
      messages: [
        { role: "system", content: ROAST_SYSTEM_PROMPT },
        { role: "user", content: options.userPrompt },
      ],
      ...options.extraBody,
    }),
  });

  const data = (await res.json()) as OpenAIChatResponse;
  // Logged before the error checks: a failed call still burns tokens, which
  // matters most on the paid provider.
  logOpenAiUsage(options.provider, data);

  if (!res.ok) {
    const message =
      data.error?.message || `${options.provider} HTTP ${res.status}`;
    const quotaLike =
      isRetryableStatus(res.status) || isQuotaLikeMessage(message);
    throw Object.assign(new Error(message), {
      quotaLike,
      tooLarge: isPromptTooLargeMessage(message),
      emptyCompletion: false,
    });
  }

  const text = extractModelText(data);
  if (!text) {
    logEmptyCompletionPayload(options.provider, data);
    throw Object.assign(
      new Error(`${options.provider} returned an empty roast.`),
      { quotaLike: false, tooLarge: false, emptyCompletion: true },
    );
  }

  return text;
}

async function callWorkersAi(env: Env, userPrompt: string): Promise<string> {
  if (!env.AI) {
    throw Object.assign(new Error("Workers AI binding is not configured."), {
      quotaLike: false,
      tooLarge: false,
      emptyCompletion: false,
    });
  }

  const model = workersAiModel(env);
  try {
    const inputs: Record<string, unknown> = {
      messages: [
        { role: "system", content: ROAST_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 2048,
      temperature: 0.9,
    };
    // GLM defaults thinking on; disable when using that family.
    if (/glm/i.test(model)) {
      inputs.thinking = { type: "disabled" };
    }

    const raw = await env.AI.run(
      model as Parameters<Ai["run"]>[0],
      inputs as Parameters<Ai["run"]>[1],
    );

    const text = extractModelText(raw);
    if (!text) {
      logEmptyCompletionPayload("Workers AI", raw);
      throw Object.assign(new Error("Workers AI returned an empty roast."), {
        quotaLike: false,
        tooLarge: false,
        emptyCompletion: true,
      });
    }
    return text;
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "quotaLike" in err &&
      ("tooLarge" in err || "emptyCompletion" in err)
    ) {
      throw err;
    }
    const message =
      err instanceof Error ? err.message : "Workers AI failed unexpectedly";
    throw Object.assign(new Error(message), {
      quotaLike: isQuotaLikeMessage(message),
      tooLarge: isPromptTooLargeMessage(message),
      emptyCompletion: false,
    });
  }
}

function failureFromUnknown(provider: string, err: unknown): ProviderFailure {
  const message =
    err instanceof Error ? err.message : `${provider} failed unexpectedly`;
  const quotaLike =
    typeof err === "object" &&
    err !== null &&
    "quotaLike" in err &&
    Boolean((err as { quotaLike?: boolean }).quotaLike);
  return {
    provider,
    message,
    quotaLike: quotaLike || isQuotaLikeMessage(message),
  };
}

function isTooLargeError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "tooLarge" in err) {
    return Boolean((err as { tooLarge?: boolean }).tooLarge);
  }
  if (err instanceof Error) return isPromptTooLargeMessage(err.message);
  return false;
}

function isEmptyCompletionError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "emptyCompletion" in err) {
    return Boolean((err as { emptyCompletion?: boolean }).emptyCompletion);
  }
  if (err instanceof Error) return /empty roast/i.test(err.message);
  return false;
}

/**
 * Call a provider; on prompt-too-large or empty completion, shrink and retry once.
 * Returns roast text plus the packed filenames used for path filtering.
 */
async function runWithShrinkRetry(
  input: RoastInput,
  provider: ProviderName,
  budget: PackOptions,
  call: (userPrompt: string) => Promise<string>,
): Promise<PackedPrompt & { text: string }> {
  let current = budget;
  let lastErr: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const packed = buildPackedPrompt(input, current);
    try {
      const text = await call(packed.userPrompt);
      return { ...packed, text };
    } catch (err) {
      lastErr = err;
      // Groq free tier is 8k TPM: an empty→shrink retry often rate-limits the
      // second call. Only shrink there on explicit "too large" errors.
      const emptyOkToShrink =
        isEmptyCompletionError(err) && provider !== "groq";
      const shouldShrink =
        attempt === 0 && (isTooLargeError(err) || emptyOkToShrink);
      if (shouldShrink) {
        const reason = isEmptyCompletionError(err)
          ? "empty completion"
          : "prompt too large";
        console.error(
          `Roast provider ${provider}: ${reason}, retrying at 50% budget`,
        );
        current = scaleBudget(current, 0.5);
        continue;
      }
      throw err;
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(`${provider} failed after shrink retry`);
}

/**
 * Generate a roast through the provider chain, in PROVIDER_PRIORITY order: the
 * optional paid OpenAI-compatible endpoint first, then Gemini, Workers AI, Groq.
 * Each provider gets a budget-sized pack of the same PR files (not one shared megaprompt).
 * Groq is last: its 6k pack + weak instruction-following invents claims on thin slices.
 */
export async function generateRoast(
  env: Env,
  input: RoastInput,
): Promise<RoastResult> {
  const failures: ProviderFailure[] = [];

  for (const warning of providerConfigWarnings(env)) {
    console.error(warning);
  }

  /**
   * Per-provider call wiring. Order comes from PROVIDER_PRIORITY, so the paid
   * provider stays first without this map encoding a second ordering.
   */
  const builders: Record<
    ProviderName,
    () => { model: string; run: () => Promise<PackedPrompt & { text: string }> }
  > = {
    openai: () => ({
      model: env.OPENAI_MODEL || "",
      run: () =>
        runWithShrinkRetry(
          input,
          "openai",
          budgetForProvider(env, "openai"),
          (userPrompt) =>
            callOpenAICompatible({
              provider: "OpenAI",
              url: `${openaiBaseUrl(env)}/chat/completions`,
              apiKey: env.OPENAI_API_KEY!,
              model: env.OPENAI_MODEL!,
              userPrompt,
              maxTokens: 2_048,
              maxTokensField: openaiMaxTokensField(env),
              // Reasoning models only accept the default temperature.
              omitTemperature: true,
              extraBody: env.OPENAI_REASONING_EFFORT
                ? { reasoning_effort: env.OPENAI_REASONING_EFFORT }
                : undefined,
            }),
        ),
    }),
    gemini: () => ({
      model: geminiModel(env),
      run: () =>
        runWithShrinkRetry(
          input,
          "gemini",
          budgetForProvider(env, "gemini"),
          (userPrompt) => callGemini(env, userPrompt),
        ),
    }),
    workersai: () => ({
      model: workersAiModel(env),
      run: () =>
        runWithShrinkRetry(
          input,
          "workersai",
          budgetForProvider(env, "workersai"),
          (userPrompt) => callWorkersAi(env, userPrompt),
        ),
    }),
    groq: () => ({
      model: groqModel(env),
      run: () =>
        runWithShrinkRetry(
          input,
          "groq",
          budgetForProvider(env, "groq"),
          (userPrompt) =>
            callOpenAICompatible({
              provider: "Groq",
              url: "https://api.groq.com/openai/v1/chat/completions",
              apiKey: env.GROQ_API_KEY!,
              model: groqModel(env),
              userPrompt,
              // Stay inside free-tier 8k TPM with room for one attempt.
              maxTokens: 1024,
              // gpt-oss puts CoT in `reasoning` and often leaves `content` empty
              // unless reasoning is hidden / effort lowered.
              extraBody: {
                include_reasoning: false,
                reasoning_effort: "low",
              },
            }),
        ),
    }),
  };

  const attempts: Array<{
    name: ProviderName;
    model: string;
    enabled: boolean;
    run: () => Promise<PackedPrompt & { text: string }>;
  }> = PROVIDER_PRIORITY.map((name) => ({
    name,
    enabled: PROVIDER_ENABLED[name](env),
    ...builders[name](),
  }));

  const configured = attempts.filter((a) => a.enabled);
  if (configured.length === 0) {
    throw new RoastError("No AI providers configured.");
  }

  console.error(
    `Roast provider order: ${configured.map((a) => a.name).join(" → ")}`,
  );

  for (const attempt of configured) {
    try {
      const { text, includedFilenames, coverage, truncated, packedDiff } =
        await attempt.run();
      if (!text.trim()) {
        failures.push({
          provider: attempt.name,
          message: `${attempt.name} returned an empty roast.`,
          quotaLike: false,
        });
        continue;
      }

      // Pull the F1/F2 accounting out first: those lines are bookkeeping, not
      // review prose, and they would otherwise look like unpinned bullets.
      const { accounting, text: roastBody } = parseFindingAccounting(text);
      if (accounting.size > 0) {
        console.error(
          `Roast accounting (${attempt.name}): ${[...accounting]
            .map(([id, status]) => `${id}=${status}`)
            .join(" ")}`,
        );
      }

      const filtered = filterRoastByPackedPaths(roastBody, includedFilenames);
      if (filtered.dropped > 0) {
        console.error(
          `Roast path filter (${attempt.name}): kept=${filtered.kept} dropped=${filtered.dropped}`,
        );
      }

      const evidenced = filterUnverifiedAbsoluteClaims(
        filtered.text,
        packedDiff,
      );
      if (evidenced.dropped > 0) {
        console.error(
          `Roast evidence filter (${attempt.name}): kept=${evidenced.kept} dropped=${evidenced.dropped}`,
        );
      }

      const deduped = dropResolvedRepeats(
        evidenced.text,
        input.priorFindings,
        accounting,
      );
      if (deduped.dropped > 0) {
        console.error(
          `Roast repeat filter (${attempt.name}): dropped=${deduped.dropped} bullet(s) re-raising findings marked resolved`,
        );
      }

      const intented = dropIntentContradictingFixIts(
        deduped.text,
        input.commitMessages ?? [],
      );
      if (intented.dropped > 0) {
        console.error(
          `Roast intent filter (${attempt.name}): dropped=${intented.dropped} Fix-it bullet(s) undoing stated commit constraints`,
        );
      }

      const dehedged = stripHedgeCloser(intented.text);

      const coverageNote = buildPartialReviewNote(coverage, {
        provider: attempt.name,
        truncated,
      });
      if (coverageNote) {
        console.error(
          `Roast coverage (${attempt.name}): ${coverage.includedFiles}/${coverage.totalFiles} files, ${coverage.shownChars}/${coverage.totalChars} patch chars — labelled partial`,
        );
      }

      return {
        text: coverageNote
          ? `${coverageNote}\n\n${dehedged.text}`
          : dehedged.text,
        provider: attempt.name,
        model: attempt.model,
        coverage,
      };
    } catch (err) {
      const failure = failureFromUnknown(attempt.name, err);
      failures.push(failure);
      console.error(
        `Roast provider ${attempt.name} failed:`,
        failure.message,
      );
    }
  }

  const summary = failures
    .map((f) => `${f.provider}: ${f.message}`)
    .join(" | ");
  const allQuotaLike = failures.every((f) => f.quotaLike);

  if (allQuotaLike) {
    throw new RoastQuotaError(summary);
  }
  throw new RoastError(summary);
}
