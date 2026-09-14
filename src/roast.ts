import type { Env } from "./types.js";
import { buildUserPrompt, ROAST_SYSTEM_PROMPT } from "./prompts.js";

export class GeminiQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiQuotaError";
  }
}

export class GeminiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiError";
  }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  error?: { message?: string; status?: string; code?: number };
}

export async function generateRoast(
  env: Env,
  input: {
    owner: string;
    repo: string;
    number: number;
    title: string;
    body: string;
    author: string;
    diff: string;
    truncated: boolean;
  },
): Promise<string> {
  const model = env.GEMINI_MODEL || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;

  const userPrompt = buildUserPrompt(input);

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
    if (res.status === 429 || data.error?.status === "RESOURCE_EXHAUSTED") {
      throw new GeminiQuotaError(message);
    }
    throw new GeminiError(message);
  }

  const text = data.candidates?.[0]?.content?.parts
    ?.map((p) => p.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new GeminiError("Gemini returned an empty roast.");
  }

  return text;
}
