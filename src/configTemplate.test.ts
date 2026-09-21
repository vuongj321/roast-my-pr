import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * `wrangler.toml` is the file every self-host operator deploys, so what it ships
 * is a promise to them: nothing is wired to a paid vendor by default, and the
 * globals it sets are the ones the README documents.
 *
 * Both drifts happened on PR #4 â€” a committed `OPENAI_MODEL` while `src/types.ts`
 * and the README said "no default", and a `MAX_DIFF_CHARS` bump that left the
 * README table advertising the old number. These are the guards.
 */
const wrangler = readFileSync(
  new URL("../wrangler.toml", import.meta.url),
  "utf8",
);
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

/** True when `NAME = ...` appears as a live assignment (a `#` comment is not one). */
function isAssigned(source: string, name: string): boolean {
  return new RegExp(`^\\s*${name}\\s*=`, "m").test(source);
}

describe("wrangler.toml against the README", () => {
  it("ships no paid provider configuration", () => {
    const paidVars = [
      "OPENAI_API_KEY",
      "OPENAI_MODEL",
      "OPENAI_BASE_URL",
      "OPENAI_REASONING_EFFORT",
      "OPENAI_MAX_TOKENS_FIELD",
    ];

    for (const name of paidVars) {
      assert.equal(
        isAssigned(wrangler, name),
        false,
        `${name} must stay commented out: deploying the template as-is must not bill anyone`,
      );
    }
  });

  it("ships the MAX_DIFF_CHARS default the README documents", () => {
    const shipped = /^\s*MAX_DIFF_CHARS\s*=\s*"(\d+)"/m.exec(wrangler)?.[1];
    const documented = /\|\s*`MAX_DIFF_CHARS`\s*\|\s*`(\d+)`\s*\|/.exec(readme)?.[1];

    assert.ok(shipped, "wrangler.toml must set MAX_DIFF_CHARS");
    assert.ok(documented, "README must document MAX_DIFF_CHARS");
    assert.equal(shipped, documented);
  });

  it("keeps the README's no-default claim for the paid model", () => {
    assert.match(readme, /\|\s*`OPENAI_MODEL`\s*\|\s*\*\(none\)\*\s*\|/);
  });
});
