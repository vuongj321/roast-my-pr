import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_PRIOR_ROAST_CHARS,
  ROAST_SYSTEM_PROMPT,
  buildRoastFooter,
  buildUserPrompt,
  truncatePriorRoast,
} from "./prompts.js";

const basePromptInput = {
  owner: "acme",
  repo: "widgets",
  number: 7,
  title: "Add widgets",
  body: "Does the thing",
  author: "jane",
  diff: "+ console.log(1)",
  truncated: false,
  includedFiles: 1,
  totalFiles: 1,
};

describe("truncatePriorRoast", () => {
  it("leaves short text alone", () => {
    assert.equal(truncatePriorRoast("short"), "short");
  });

  it("truncates long prior roasts", () => {
    const long = "x".repeat(MAX_PRIOR_ROAST_CHARS + 50);
    const out = truncatePriorRoast(long);
    assert.ok(out.length <= MAX_PRIOR_ROAST_CHARS);
    assert.match(out, /prior roast truncated/);
  });
});

describe("buildUserPrompt", () => {
  it("omits prior section when priorRoast is null or empty", () => {
    const a = buildUserPrompt({ ...basePromptInput, priorRoast: null });
    const b = buildUserPrompt({ ...basePromptInput, priorRoast: "  " });
    const c = buildUserPrompt(basePromptInput);
    for (const prompt of [a, b, c]) {
      assert.doesNotMatch(prompt, /Previous Roast my PR review/);
    }
  });

  it("includes prior section and verification instructions when set", () => {
    const prior = `Missing transactions${buildRoastFooter("gemini-3.6-flash")}`;
    const prompt = buildUserPrompt({
      ...basePromptInput,
      priorRoast: prior,
    });
    assert.match(prompt, /Previous Roast my PR review/);
    assert.match(prompt, /Missing transactions/);
    assert.match(prompt, /claims to re-check/);
    assert.match(prompt, /Only repeat an issue/);
    assert.doesNotMatch(prompt, /Evidence:/);
  });

  it("truncates a long prior roast inside the prompt", () => {
    const prior = "y".repeat(MAX_PRIOR_ROAST_CHARS + 100);
    const prompt = buildUserPrompt({
      ...basePromptInput,
      priorRoast: prior,
    });
    assert.match(prompt, /prior roast truncated/);
    assert.ok(!prompt.includes(prior));
  });
});

describe("ROAST_SYSTEM_PROMPT", () => {
  it("keeps soft prior-roast rules without Evidence requirements", () => {
    assert.match(ROAST_SYSTEM_PROMPT, /hypotheses to re-check/);
    assert.match(ROAST_SYSTEM_PROMPT, /already present in the packed diff/);
    assert.doesNotMatch(ROAST_SYSTEM_PROMPT, /Evidence:/);
  });
});
