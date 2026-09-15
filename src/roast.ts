import type { Env } from "./types.js";
import {
  PROVIDER_DIFF_BUDGETS,
  extractCitedPaths,
  packPullContext,
  type DiffFile,
  type PackOptions,
  type ProviderName,
} from "./diffPack.js";
import { filterRoastByEvidence } from "./evidenceFilter.js";
import { buildUserPrompt, ROAST_SYSTEM_PROMPT } from "./prompts.js";

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

/** Model replied but no bullets survived Evidence verification. */
export class RoastUnverifiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoastUnverifiedError";
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
  /** True when the model replied but Evidence filter kept nothing. */
  evidenceEmpty?: boolean;
};

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
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
): { userPrompt: string; truncated: boolean; packedDiff: string } {
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
  return env.WORKERS_AI_MODEL || "@cf/zai-org/glm-4.7-flash";
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
        maxOutputTokens: 2048,
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
    });
  }

  const text = data.candidates?.[0]?.content?.parts
    ?.map((p) => p.text || "")
    .join("")
    .trim();

  if (!text) {
    throw Object.assign(new Error("Gemini returned an empty roast."), {
      quotaLike: false,
      tooLarge: false,
    });
  }

  return text;
}

async function callOpenAICompatible(options: {
  provider: string;
  url: string;
  apiKey: string;
  model: string;
  userPrompt: string;
  extraHeaders?: Record<string, string>;
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
      max_tokens: 2048,
      messages: [
        { role: "system", content: ROAST_SYSTEM_PROMPT },
        { role: "user", content: options.userPrompt },
      ],
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
    });
  }

  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw Object.assign(
      new Error(`${options.provider} returned an empty roast.`),
      { quotaLike: false, tooLarge: false },
    );
  }

  return text;
}

function textFromWorkersAiResult(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const obj = data as Record<string, unknown>;

  if (typeof obj.response === "string" && obj.response.trim()) {
    return obj.response.trim();
  }

  const choices = obj.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    const message = (choices[0] as { message?: { content?: string | null } })
      .message;
    const content = message?.content?.trim();
    if (content) return content;
  }

  return "";
}

async function callWorkersAi(env: Env, userPrompt: string): Promise<string> {
  if (!env.AI) {
    throw Object.assign(new Error("Workers AI binding is not configured."), {
      quotaLike: false,
      tooLarge: false,
    });
  }

  const model = workersAiModel(env);
  try {
    const raw = await env.AI.run(model as Parameters<Ai["run"]>[0], {
      messages: [
        { role: "system", content: ROAST_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 2048,
      temperature: 0.9,
    } as Parameters<Ai["run"]>[1]);

    const text = textFromWorkersAiResult(raw);
    if (!text) {
      throw Object.assign(new Error("Workers AI returned an empty roast."), {
        quotaLike: false,
        tooLarge: false,
      });
    }
    return text;
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "quotaLike" in err &&
      "tooLarge" in err
    ) {
      throw err;
    }
    const message =
      err instanceof Error ? err.message : "Workers AI failed unexpectedly";
    throw Object.assign(new Error(message), {
      quotaLike: isQuotaLikeMessage(message),
      tooLarge: isPromptTooLargeMessage(message),
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

/**
 * Call a provider; on prompt-too-large, shrink the packed diff and retry once.
 * Returns roast text plus the packed diff used for evidence verification.
 */
async function runWithShrinkRetry(
  input: RoastInput,
  provider: ProviderName,
  budget: PackOptions,
  call: (userPrompt: string) => Promise<string>,
): Promise<{ text: string; packedDiff: string }> {
  let current = budget;
  let lastErr: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { userPrompt, packedDiff } = buildPackedPrompt(input, current);
    try {
      const text = await call(userPrompt);
      return { text, packedDiff };
    } catch (err) {
      lastErr = err;
      if (attempt === 0 && isTooLargeError(err)) {
        console.error(
          `Roast provider ${provider}: prompt too large, retrying at 50% budget`,
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
    run: () => Promise<{ text: string; packedDiff: string }>;
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
      const { text, packedDiff } = await attempt.run();
      const filtered = filterRoastByEvidence(text, packedDiff);
      if (filtered.dropped > 0) {
        console.error(
          `Roast evidence filter (${attempt.name}): kept=${filtered.kept} dropped=${filtered.dropped}`,
        );
      }
      // Empty verified review is not useful — treat as provider failure and try next.
      if (filtered.kept === 0) {
        failures.push({
          provider: attempt.name,
          message: "evidence filter dropped all bullets",
          quotaLike: false,
          evidenceEmpty: true,
        });
        console.error(
          `Roast provider ${attempt.name}: no verifiable Evidence quotes; trying next provider`,
        );
        continue;
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
  const onlyUnverifiedOrQuota = failures.every(
    (f) => f.quotaLike || f.evidenceEmpty,
  );
  const anyUnverified = failures.some((f) => f.evidenceEmpty);

  if (allQuotaLike) {
    throw new RoastQuotaError(summary);
  }
  if (anyUnverified && onlyUnverifiedOrQuota) {
    throw new RoastUnverifiedError(summary);
  }
  throw new RoastError(summary);
}
