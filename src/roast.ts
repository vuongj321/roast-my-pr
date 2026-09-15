import type { Env } from "./types.js";
import {
  PROVIDER_DIFF_BUDGETS,
  extractCitedPaths,
  packPullContext,
  type DiffFile,
  type PackOptions,
  type ProviderName,
} from "./diffPack.js";
import { filterRoastByPackedPaths } from "./pathFilter.js";
import { buildUserPrompt, ROAST_SYSTEM_PROMPT } from "./prompts.js";
import {
  extractModelText,
  isTruncatedRoastText,
  isUsableRoastText,
  logEmptyCompletionPayload,
} from "./responseText.js";

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

function buildPackedPrompt(
  input: RoastInput,
  budget: PackOptions,
): {
  userPrompt: string;
  truncated: boolean;
  packedDiff: string;
  includedFilenames: string[];
} {
  const priorityPaths = new Set(extractCitedPaths(input.priorRoast || ""));
  const packed = packPullContext(
    input.files,
    input.body,
    budget,
    input.filesIncomplete,
    priorityPaths,
  );
  return {
    truncated: packed.truncated,
    packedDiff: packed.diff,
    includedFilenames: packed.includedFilenames,
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
      priorRoast: input.priorRoast,
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

export type RoastResult = {
  text: string;
  provider: ProviderName;
  model: string;
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

async function callOpenAICompatible(options: {
  provider: string;
  url: string;
  apiKey: string;
  model: string;
  userPrompt: string;
  maxTokens?: number;
  extraHeaders?: Record<string, string>;
  /** Extra OpenAI-compatible body fields (e.g. Groq reasoning controls). */
  extraBody?: Record<string, unknown>;
}): Promise<string> {
  const res = await fetch(options.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
      ...options.extraHeaders,
    },
    body: JSON.stringify({
      model: options.model,
      temperature: 0.9,
      max_tokens: options.maxTokens ?? 2048,
      messages: [
        { role: "system", content: ROAST_SYSTEM_PROMPT },
        { role: "user", content: options.userPrompt },
      ],
      ...options.extraBody,
    }),
  });

  const data = (await res.json()) as OpenAIChatResponse;

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
): Promise<{
  text: string;
  packedDiff: string;
  includedFilenames: string[];
}> {
  let current = budget;
  let lastErr: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { userPrompt, packedDiff, includedFilenames } = buildPackedPrompt(
      input,
      current,
    );
    try {
      const text = await call(userPrompt);
      return { text, packedDiff, includedFilenames };
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
 * Generate a roast via Gemini, falling back to Groq then Workers AI on failure.
 * Each provider gets a budget-sized pack of the same PR files (not one shared megaprompt).
 */
export async function generateRoast(
  env: Env,
  input: RoastInput,
): Promise<RoastResult> {
  const failures: ProviderFailure[] = [];

  const attempts: Array<{
    name: ProviderName;
    model: string;
    enabled: boolean;
    run: () => Promise<{
      text: string;
      packedDiff: string;
      includedFilenames: string[];
    }>;
  }> = [
    {
      name: "gemini",
      model: geminiModel(env),
      enabled: Boolean(env.GEMINI_API_KEY),
      run: () =>
        runWithShrinkRetry(
          input,
          "gemini",
          budgetForProvider(env, "gemini"),
          (userPrompt) => callGemini(env, userPrompt),
        ),
    },
    {
      name: "groq",
      model: groqModel(env),
      enabled: Boolean(env.GROQ_API_KEY),
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
    },
    {
      name: "workersai",
      model: workersAiModel(env),
      enabled: Boolean(env.AI),
      run: () =>
        runWithShrinkRetry(
          input,
          "workersai",
          budgetForProvider(env, "workersai"),
          (userPrompt) => callWorkersAi(env, userPrompt),
        ),
    },
  ];

  const configured = attempts.filter((a) => a.enabled);
  if (configured.length === 0) {
    throw new RoastError("No AI providers configured.");
  }

  for (const attempt of configured) {
    try {
      const { text, includedFilenames } = await attempt.run();
      if (!text.trim()) {
        failures.push({
          provider: attempt.name,
          message: `${attempt.name} returned an empty roast.`,
          quotaLike: false,
        });
        continue;
      }
      const filtered = filterRoastByPackedPaths(text, includedFilenames);
      if (filtered.dropped > 0) {
        console.error(
          `Roast path filter (${attempt.name}): kept=${filtered.kept} dropped=${filtered.dropped}`,
        );
      }
      return {
        text: filtered.text,
        provider: attempt.name,
        model: attempt.model,
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
