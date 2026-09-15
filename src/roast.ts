import type { Env } from "./types.js";
import {
  PROVIDER_DIFF_BUDGETS,
  packPullContext,
  type DiffFile,
  type PackOptions,
  type ProviderName,
} from "./diffPack.js";
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
};

type ProviderFailure = {
  provider: string;
  message: string;
  quotaLike: boolean;
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
    lower.includes("overloaded")
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
    lower.includes("payload too large")
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
): { userPrompt: string; truncated: boolean } {
  const packed = packPullContext(
    input.files,
    input.body,
    budget,
    input.filesIncomplete,
  );
  return {
    truncated: packed.truncated,
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
    }),
  };
}

async function callGemini(env: Env, userPrompt: string): Promise<string> {
  const model = env.GEMINI_MODEL || "gemini-3.6-flash";
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
 */
async function runWithShrinkRetry(
  input: RoastInput,
  provider: ProviderName,
  budget: PackOptions,
  call: (userPrompt: string) => Promise<string>,
): Promise<string> {
  let current = budget;
  let lastErr: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { userPrompt } = buildPackedPrompt(input, current);
    try {
      return await call(userPrompt);
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
 * Generate a roast via Gemini, falling back to Groq then OpenRouter on failure.
 * Each provider gets a budget-sized pack of the same PR files (not one shared megaprompt).
 */
export async function generateRoast(
  env: Env,
  input: RoastInput,
): Promise<string> {
  const failures: ProviderFailure[] = [];

  const attempts: Array<{
    name: ProviderName;
    enabled: boolean;
    run: () => Promise<string>;
  }> = [
    {
      name: "gemini",
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
              model: env.GROQ_MODEL || "openai/gpt-oss-20b",
              userPrompt,
            }),
        ),
    },
    {
      name: "openrouter",
      enabled: Boolean(env.OPENROUTER_API_KEY),
      run: () =>
        runWithShrinkRetry(
          input,
          "openrouter",
          budgetForProvider(env, "openrouter"),
          (userPrompt) =>
            callOpenAICompatible({
              provider: "OpenRouter",
              url: "https://openrouter.ai/api/v1/chat/completions",
              apiKey: env.OPENROUTER_API_KEY!,
              model: env.OPENROUTER_MODEL || "openrouter/free",
              userPrompt,
              extraHeaders: {
                "HTTP-Referer": "https://github.com/roast-my-pr",
                "X-Title": "Roast my PR",
              },
            }),
        ),
    },
  ];

  const configured = attempts.filter((a) => a.enabled);
  if (configured.length === 0) {
    throw new RoastError("No AI providers configured.");
  }

  for (const attempt of configured) {
    try {
      return await attempt.run();
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
