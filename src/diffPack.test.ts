import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filePriority,
  isNoiseFile,
  packPullContext,
  PROVIDER_DIFF_BUDGETS,
} from "./diffPack.js";

describe("isNoiseFile", () => {
  it("skips lockfiles and assets", () => {
    assert.equal(isNoiseFile("package-lock.json"), true);
    assert.equal(isNoiseFile("src/assets/logo.png"), true);
    assert.equal(isNoiseFile("dist/bundle.js"), true);
    assert.equal(isNoiseFile("src/app.ts"), false);
  });
});

describe("filePriority", () => {
  it("prefers source over docs and tests", () => {
    assert.ok(filePriority("src/app.ts") < filePriority("README.md"));
    assert.ok(filePriority("src/app.ts") < filePriority("src/app.test.ts"));
    assert.ok(filePriority("src/app.ts") < filePriority("package-lock.json"));
  });
});

describe("packPullContext", () => {
  it("packs source and lists omitted lockfiles", () => {
    const packed = packPullContext(
      [
        {
          filename: "package-lock.json",
          status: "modified",
          patch: "+".repeat(5_000),
        },
        {
          filename: "src/app.ts",
          status: "modified",
          patch: "@@\n-old\n+new\n",
        },
      ],
      "A small fix",
      { maxTotalChars: 4_000, maxPerFileChars: 2_000, maxBodyChars: 500 },
    );

    assert.match(packed.diff, /src\/app\.ts/);
    assert.match(packed.diff, /package-lock\.json/);
    assert.match(packed.diff, /skipped noisy/);
    assert.equal(packed.includedFiles, 1);
    assert.equal(packed.truncated, true);
  });

  it("respects total budget and still includes an inventory", () => {
    const files = Array.from({ length: 8 }, (_, i) => ({
      filename: `src/file${i}.ts`,
      status: "modified",
      patch: `@@\n${"x".repeat(800)}\n`,
    }));

    const packed = packPullContext(files, "body", {
      maxTotalChars: 2_500,
      maxPerFileChars: 1_000,
      maxBodyChars: 200,
    });

    assert.ok(packed.includedFiles >= 1);
    assert.ok(packed.includedFiles < files.length);
    assert.match(packed.diff, /Omitted from detailed review/);
    assert.ok(packed.diff.length < 6_000);
  });

  it("groq budget stays far under an 8k-token-ish ceiling", () => {
    const files = Array.from({ length: 40 }, (_, i) => ({
      filename: `src/mod${i}.ts`,
      status: "modified",
      patch: `@@\n${"code line\n".repeat(200)}`,
    }));

    const packed = packPullContext(
      files,
      "x".repeat(5_000),
      PROVIDER_DIFF_BUDGETS.groq,
    );

    // Diff + body should be well under ~28k chars (~8k tokens at ~3.5 chars/token).
    assert.ok(packed.body.length <= PROVIDER_DIFF_BUDGETS.groq.maxBodyChars + 50);
    assert.ok(packed.diff.length < 20_000);
  });
});
