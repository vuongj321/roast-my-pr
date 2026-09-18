import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ROAST_SYSTEM_PROMPT } from "./prompts.js";
import {
  PROVIDER_PRIORITY,
  callOpenAICompatible,
  enabledProviders,
  fetchWithTimeout,
  generateRoast,
  providerConfigWarnings,
  type RoastInput,
} from "./roast.js";
import type { Env } from "./types.js";

/** Minimal Env; AI/RATE_LIMIT are only touched when those providers are enabled. */
function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    APP_ID: "1",
    PRIVATE_KEY: "key",
    WEBHOOK_SECRET: "secret",
    GEMINI_API_KEY: "gemini-key",
    GEMINI_MODEL: "gemini-3.6-flash",
    GROQ_MODEL: "openai/gpt-oss-20b",
    DAILY_ROAST_LIMIT: "20",
    MAX_DIFF_CHARS: "48000",
    ...overrides,
  } as Env;
}

const PAID_MODEL = "gpt-5.6-terra";

const ROAST = `# Renames that fix nothing

### What I'd send back
* \`src/a.ts\` is dead weight.

### Fix it
1. Delete it.

Ship it.`;

const INPUT: RoastInput = {
  owner: "acme",
  repo: "widgets",
  number: 1,
  title: "Cleanup",
  body: "Removes stuff",
  author: "jane",
  files: [
    {
      filename: "src/a.ts",
      status: "modified",
      patch: "@@ -1,2 +1,2 @@\n-old line\n+new line",
    },
  ],
  filesIncomplete: false,
  commitMessages: ["chore: cleanup"],
};

type FetchCall = { url: string; body: Record<string, unknown> };
type Message = { role: string; content: string };

const realFetch = globalThis.fetch;
const realConsoleError = console.error;

function openAiPayload(): unknown {
  return {
    choices: [{ message: { role: "assistant", content: ROAST } }],
    usage: { prompt_tokens: 111, completion_tokens: 22, total_tokens: 133 },
  };
}

function geminiPayload(): unknown {
  return {
    candidates: [
      { content: { parts: [{ text: ROAST }] }, finishReason: "STOP" },
    ],
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Stub fetch, recording the URL and parsed JSON body of every call. */
function stubFetch(
  handler: (call: FetchCall, index: number) => Response,
): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const body = JSON.parse(
      String(init?.body ?? "{}"),
    ) as Record<string, unknown>;
    const call: FetchCall = { url, body };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return calls;
}

function sentPrompt(call: FetchCall): string {
  const messages = call.body.messages as Message[] | undefined;
  return messages?.[1]?.content ?? "";
}

type AiCall = { model: string; inputs: Record<string, unknown> };

/**
 * Env whose only enabled provider is Workers AI (Gemini key cleared), with a
 * stubbed binding that records the model and inputs of every call.
 */
function aiEnv(
  calls: AiCall[],
  handler: (call: AiCall, index: number) => unknown,
): Env {
  return fakeEnv({
    GEMINI_API_KEY: "",
    AI: {
      run: async (model: string, inputs: Record<string, unknown>) => {
        const call: AiCall = { model, inputs };
        calls.push(call);
        return handler(call, calls.length - 1);
      },
    } as unknown as Env["AI"],
  });
}

beforeEach(() => {
  // The provider chain is chatty on purpose; keep the test output readable.
  console.error = () => {};
});

afterEach(() => {
  console.error = realConsoleError;
  globalThis.fetch = realFetch;
});

describe("PROVIDER_PRIORITY", () => {
  it("tries the paid provider first, then the free tiers", () => {
    assert.deepEqual([...PROVIDER_PRIORITY], [
      "openai",
      "gemini",
      "workersai",
      "groq",
    ]);
  });
});

describe("enabledProviders", () => {
  it("puts a fully configured paid provider first", () => {
    const env = fakeEnv({
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: PAID_MODEL,
      GROQ_API_KEY: "groq-key",
      AI: {} as unknown as Env["AI"],
    });
    assert.deepEqual(enabledProviders(env), [
      "openai",
      "gemini",
      "workersai",
      "groq",
    ]);
  });

  it("requires both the paid key and the paid model", () => {
    assert.deepEqual(enabledProviders(fakeEnv({ OPENAI_API_KEY: "sk-test" })), [
      "gemini",
    ]);
    assert.deepEqual(enabledProviders(fakeEnv({ OPENAI_MODEL: PAID_MODEL })), [
      "gemini",
    ]);
  });

  it("skips providers whose credentials are missing", () => {
    assert.deepEqual(enabledProviders(fakeEnv()), ["gemini"]);
  });
});

describe("providerConfigWarnings", () => {
  it("warns when the paid key has no model", () => {
    const warnings = providerConfigWarnings(
      fakeEnv({ OPENAI_API_KEY: "sk-test" }),
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /OPENAI_MODEL is missing/);
    assert.match(warnings[0]!, /paid provider skipped/);
  });

  it("warns when the paid model has no key", () => {
    const warnings = providerConfigWarnings(
      fakeEnv({ OPENAI_MODEL: PAID_MODEL }),
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /OPENAI_API_KEY is missing/);
  });

  it("stays quiet when the paid provider is complete or absent", () => {
    assert.deepEqual(
      providerConfigWarnings(
        fakeEnv({ OPENAI_API_KEY: "sk-test", OPENAI_MODEL: PAID_MODEL }),
      ),
      [],
    );
    assert.deepEqual(providerConfigWarnings(fakeEnv()), []);
  });
});

describe("callOpenAICompatible", () => {
  it("sends the paid request shape and reads message.content", async () => {
    const calls = stubFetch(() => jsonResponse(openAiPayload()));

    const text = await callOpenAICompatible({
      provider: "OpenAI",
      url: "https://gateway.example/openai/v1/chat/completions",
      apiKey: "sk-test",
      model: PAID_MODEL,
      userPrompt: "review this",
      maxTokens: 2_048,
      maxTokensField: "max_completion_tokens",
      omitTemperature: true,
      extraBody: { reasoning_effort: "low" },
    });

    assert.equal(text, ROAST);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]!.url,
      "https://gateway.example/openai/v1/chat/completions",
    );
    assert.equal(calls[0]!.body.model, PAID_MODEL);
    assert.equal(calls[0]!.body.max_completion_tokens, 2_048);
    assert.equal(calls[0]!.body.max_tokens, undefined);
    assert.equal(calls[0]!.body.temperature, undefined);
    assert.equal(calls[0]!.body.reasoning_effort, "low");
    assert.deepEqual(calls[0]!.body.messages, [
      { role: "system", content: ROAST_SYSTEM_PROMPT },
      { role: "user", content: "review this" },
    ]);
  });

  it("keeps the legacy Groq request shape by default", async () => {
    const calls = stubFetch(() => jsonResponse(openAiPayload()));

    await callOpenAICompatible({
      provider: "Groq",
      url: "https://api.groq.com/openai/v1/chat/completions",
      apiKey: "gsk-test",
      model: "openai/gpt-oss-20b",
      userPrompt: "review this",
      maxTokens: 1024,
    });

    assert.equal(calls[0]!.body.max_tokens, 1024);
    assert.equal(calls[0]!.body.max_completion_tokens, undefined);
    assert.equal(calls[0]!.body.temperature, 0.9);
  });

  it("omits the token cap when asked", async () => {
    const calls = stubFetch(() => jsonResponse(openAiPayload()));

    await callOpenAICompatible({
      provider: "OpenAI",
      url: "https://api.openai.com/v1/chat/completions",
      apiKey: "sk-test",
      model: PAID_MODEL,
      userPrompt: "review this",
      maxTokensField: "omit",
    });

    assert.equal(calls[0]!.body.max_tokens, undefined);
    assert.equal(calls[0]!.body.max_completion_tokens, undefined);
  });

  it("surfaces provider errors", async () => {
    stubFetch(() =>
      jsonResponse({ error: { message: "Incorrect API key provided" } }, 401),
    );

    await assert.rejects(
      () =>
        callOpenAICompatible({
          provider: "OpenAI",
          url: "https://api.openai.com/v1/chat/completions",
          apiKey: "sk-bad",
          model: PAID_MODEL,
          userPrompt: "review this",
        }),
      /Incorrect API key provided/,
    );
  });

  it("retries with a plainer body when the gateway refuses a field", async () => {
    const calls = stubFetch((_call, index) =>
      index === 0
        ? jsonResponse(
            {
              error: {
                message:
                  "Unsupported parameter: 'reasoning_effort' is not supported with this model.",
              },
            },
            400,
          )
        : jsonResponse(openAiPayload()),
    );

    const text = await callOpenAICompatible({
      provider: "OpenAI",
      url: "https://gateway.example/openai/v1/chat/completions",
      apiKey: "sk-test",
      model: PAID_MODEL,
      userPrompt: "review this",
      maxTokens: 2_048,
      maxTokensField: "max_completion_tokens",
      omitTemperature: true,
      extraBody: { reasoning_effort: "low" },
    });

    assert.equal(text, ROAST);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.body.reasoning_effort, "low");
    assert.equal(calls[1]!.body.reasoning_effort, undefined);
    assert.equal(calls[1]!.body.max_completion_tokens, 2_048);
    assert.equal(calls[1]!.body.model, PAID_MODEL);
  });

  it("sheds the token cap when the gateway does not know that field", async () => {
    const calls = stubFetch((_call, index) =>
      index === 0
        ? jsonResponse(
            {
              error: {
                message:
                  "Unrecognized request argument supplied: max_completion_tokens",
              },
            },
            400,
          )
        : jsonResponse(openAiPayload()),
    );

    const text = await callOpenAICompatible({
      provider: "OpenAI",
      url: "https://api.openai.com/v1/chat/completions",
      apiKey: "sk-test",
      model: PAID_MODEL,
      userPrompt: "review this",
      maxTokensField: "max_completion_tokens",
    });

    assert.equal(text, ROAST);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.body.max_completion_tokens, 2_048);
    // Last resort is `model` + `messages`, which every gateway accepts.
    assert.deepEqual(Object.keys(calls[1]!.body).sort(), ["messages", "model"]);
  });

  it("does not buy a second call for an unrelated rejection", async () => {
    const calls = stubFetch(() =>
      jsonResponse({ error: { message: "Incorrect API key provided" } }, 401),
    );

    await assert.rejects(
      () =>
        callOpenAICompatible({
          provider: "OpenAI",
          url: "https://api.openai.com/v1/chat/completions",
          apiKey: "sk-bad",
          model: PAID_MODEL,
          userPrompt: "review this",
          extraBody: { reasoning_effort: "low" },
        }),
      /Incorrect API key provided/,
    );
    assert.equal(calls.length, 1);
  });
});

describe("fetchWithTimeout", () => {
  it("gives up on a provider that never answers", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      })) as unknown as typeof fetch;

    await assert.rejects(
      () =>
        fetchWithTimeout(
          "OpenAI",
          "https://api.openai.com/v1/chat/completions",
          {},
          5,
        ),
      /did not answer within 5ms/,
    );
  });

  it("reports a connection failure as itself, not as a timeout", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as unknown as typeof fetch;

    await assert.rejects(
      () =>
        fetchWithTimeout("Gemini", "https://gateway.example/v1/messages", {}),
      /ECONNREFUSED/,
    );
  });
});

describe("generateRoast provider priority", () => {
  it("uses the paid provider and never reaches the free tiers", async () => {
    const env = fakeEnv({ OPENAI_API_KEY: "sk-test", OPENAI_MODEL: PAID_MODEL });
    const calls = stubFetch(() => jsonResponse(openAiPayload()));

    const result = await generateRoast(env, INPUT);

    assert.equal(result.provider, "openai");
    assert.equal(result.model, PAID_MODEL);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(calls[0]!.body.model, PAID_MODEL);
    assert.equal(calls[0]!.body.max_completion_tokens, 2_048);
  });

  it("keeps the usual temperature until the operator declares a reasoning model", async () => {
    const calls = stubFetch(() => jsonResponse(openAiPayload()));

    await generateRoast(
      fakeEnv({ OPENAI_API_KEY: "sk-test", OPENAI_MODEL: PAID_MODEL }),
      INPUT,
    );

    assert.equal(calls[0]!.body.temperature, 0.9);

    const reasoningCalls = stubFetch(() => jsonResponse(openAiPayload()));

    await generateRoast(
      fakeEnv({
        OPENAI_API_KEY: "sk-test",
        OPENAI_MODEL: PAID_MODEL,
        OPENAI_REASONING_EFFORT: "low",
      }),
      INPUT,
    );

    assert.equal(reasoningCalls[0]!.body.temperature, undefined);
    assert.equal(reasoningCalls[0]!.body.reasoning_effort, "low");
  });

  it("keeps the paid provider when its gateway refuses a field", async () => {
    const env = fakeEnv({
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: PAID_MODEL,
      OPENAI_REASONING_EFFORT: "low",
    });
    const calls = stubFetch((call, index) =>
      call.url.includes("api.openai.com") && index === 0
        ? jsonResponse(
            { error: { message: "unknown field `reasoning_effort`" } },
            400,
          )
        : jsonResponse(openAiPayload()),
    );

    const result = await generateRoast(env, INPUT);

    assert.equal(result.provider, "openai");
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.body.reasoning_effort, undefined);
    assert.equal(calls[1]!.body.model, PAID_MODEL);
  });

  it("honours OPENAI_BASE_URL for compatible gateways", async () => {
    const env = fakeEnv({
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: PAID_MODEL,
      OPENAI_BASE_URL: "https://gateway.example/openai/v1/",
    });
    const calls = stubFetch(() => jsonResponse(openAiPayload()));

    const result = await generateRoast(env, INPUT);

    assert.equal(result.provider, "openai");
    assert.equal(
      calls[0]!.url,
      "https://gateway.example/openai/v1/chat/completions",
    );
  });

  it("cascades to Gemini when the paid key is rejected", async () => {
    const env = fakeEnv({ OPENAI_API_KEY: "sk-bad", OPENAI_MODEL: PAID_MODEL });
    const calls = stubFetch((call) =>
      call.url.includes("api.openai.com")
        ? jsonResponse({ error: { message: "Incorrect API key provided" } }, 401)
        : jsonResponse(geminiPayload()),
    );

    const result = await generateRoast(env, INPUT);

    assert.equal(result.provider, "gemini");
    assert.equal(calls.length, 2);
    assert.match(calls[0]!.url, /api\.openai\.com/);
    assert.match(calls[1]!.url, /generativelanguage\.googleapis\.com/);
  });

  it("shrink-retries the paid provider on an oversized prompt", async () => {
    // Small MAX_DIFF_CHARS so the first pack clips and the 50% retry clips more.
    const env = fakeEnv({
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: PAID_MODEL,
      MAX_DIFF_CHARS: "20000",
    });
    const bigPatch = [
      "@@ -1,150 +1,150 @@",
      ...Array.from({ length: 150 }, (_, i) => `-old ${i} ${"x".repeat(80)}`),
      ...Array.from({ length: 150 }, (_, i) => `+new ${i} ${"x".repeat(80)}`),
    ].join("\n");
    const large: RoastInput = {
      ...INPUT,
      files: [{ filename: "src/big.ts", status: "modified", patch: bigPatch }],
    };
    const calls = stubFetch((_call, index) =>
      index === 0
        ? jsonResponse(
            {
              error: {
                message: "This model's maximum context length is 128000 tokens",
              },
            },
            400,
          )
        : jsonResponse(openAiPayload()),
    );

    const result = await generateRoast(env, large);

    assert.equal(result.provider, "openai");
    assert.equal(calls.length, 2);
    assert.ok(sentPrompt(calls[1]!).length < sentPrompt(calls[0]!).length);
  });

  it("ignores the paid provider when only the key is set", async () => {
    const env = fakeEnv({ OPENAI_API_KEY: "sk-test" });
    const calls = stubFetch(() => jsonResponse(geminiPayload()));

    const result = await generateRoast(env, INPUT);

    assert.equal(result.provider, "gemini");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /generativelanguage\.googleapis\.com/);
  });

  it("falls through when the paid model dumps planning notes", async () => {
    const env = fakeEnv({ OPENAI_API_KEY: "sk-test", OPENAI_MODEL: PAID_MODEL });
    // A planning dump: responseText rejects it as chain-of-thought, and it is not
    // a size problem, so there is no pointless 50% retry (or second invoice).
    const notes = "**Role:** reviewer\n**Constraint 1**: stay blunt.";
    const calls = stubFetch((call) =>
      call.url.includes("api.openai.com")
        ? jsonResponse({ choices: [{ message: { content: notes } }] })
        : jsonResponse(geminiPayload()),
    );

    const result = await generateRoast(env, INPUT);

    assert.equal(result.provider, "gemini");
    assert.equal(calls.length, 2);
    assert.match(calls[1]!.url, /generativelanguage\.googleapis\.com/);
  });

  it("still shrink-retries the paid provider on an empty completion", async () => {
    const env = fakeEnv({ OPENAI_API_KEY: "sk-test", OPENAI_MODEL: PAID_MODEL });
    const calls = stubFetch((call, index) =>
      call.url.includes("api.openai.com")
        ? index === 0
          ? jsonResponse({ choices: [{ message: { content: "" } }] })
          : jsonResponse(openAiPayload())
        : jsonResponse(geminiPayload()),
    );

    const result = await generateRoast(env, INPUT);

    assert.equal(result.provider, "openai");
    assert.equal(calls.length, 2);
  });

  it("reports a quota error when every provider is rate limited", async () => {
    const env = fakeEnv({ OPENAI_API_KEY: "sk-test", OPENAI_MODEL: PAID_MODEL });
    stubFetch(() =>
      jsonResponse({ error: { message: "Rate limit reached" } }, 429),
    );

    await assert.rejects(() => generateRoast(env, INPUT), {
      name: "RoastQuotaError",
    });
  });
});

describe("Workers AI reasoning control", () => {
  /** The shape of the PR #4 leak: prompt metadata plus planning labels. */
  const NOTES = `*   PR Title: \`feat(roast): add a paid provider\`
*   *Drafting the specific insults*:
*   *Closer*: "Ship it."
        Actually, it's not that bad. I'll focus on the builder execution.`;

  it("turns thinking off for reasoning families and posts the roast", async () => {
    const calls: AiCall[] = [];
    const env = aiEnv(calls, () => ({ response: ROAST }));

    const result = await generateRoast(env, INPUT);

    assert.equal(result.provider, "workersai");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.model, "@cf/google/gemma-4-26b-a4b-it");
    assert.deepEqual(calls[0]!.inputs.thinking, { type: "disabled" });
  });

  it("retries without the control when the model rejects it", async () => {
    const calls: AiCall[] = [];
    const env = aiEnv(calls, (_call, index) => {
      if (index === 0) throw new Error("Unknown parameter: thinking");
      return { response: ROAST };
    });

    const result = await generateRoast(env, INPUT);

    assert.equal(result.provider, "workersai");
    assert.equal(calls.length, 2);
    assert.equal("thinking" in calls[1]!.inputs, false);
  });

  it("rejects planning notes without a pointless shrink retry", async () => {
    const calls: AiCall[] = [];
    const env = aiEnv(calls, () => ({ response: NOTES }));

    await assert.rejects(() => generateRoast(env, INPUT), {
      name: "RoastError",
      message: /planning notes/,
    });
    assert.equal(calls.length, 1);
  });
});
