import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractCitedPaths,
  filePriority,
  isHighSignalPath,
  isNoiseFile,
  matchesPriorityPath,
  packPullContext,
  PROVIDER_DIFF_BUDGETS,
  selectPatchHunks,
  splitPatchHunks,
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

describe("isHighSignalPath", () => {
  it("flags env, schema, controllers, and package.json", () => {
    assert.equal(isHighSignalPath("apps/api/src/config/env.ts"), true);
    assert.equal(isHighSignalPath("apps/api/src/db/schema.ts"), true);
    assert.equal(
      isHighSignalPath("apps/api/src/billing/billing.controller.ts"),
      true,
    );
    assert.equal(isHighSignalPath("package.json"), true);
    assert.equal(isHighSignalPath("src/app.ts"), false);
  });
});

describe("extractCitedPaths / matchesPriorityPath", () => {
  it("extracts backtick and bare paths from prior roast text", () => {
    const paths = extractCitedPaths(
      "See `apps/api/src/orgs/orgs.service.ts` and apps/api/src/auth/auth.controller.ts please",
    );
    assert.ok(paths.includes("apps/api/src/orgs/orgs.service.ts"));
    assert.ok(paths.includes("apps/api/src/auth/auth.controller.ts"));
  });

  it("matches full paths and basenames", () => {
    const set = new Set([
      "apps/api/src/orgs/orgs.service.ts",
      "auth.controller.ts",
    ]);
    assert.equal(
      matchesPriorityPath("apps/api/src/orgs/orgs.service.ts", set),
      true,
    );
    assert.equal(
      matchesPriorityPath("apps/api/src/auth/auth.controller.ts", set),
      true,
    );
    assert.equal(matchesPriorityPath("src/other.ts", set), false);
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

  it("groq budget stays under an 8k-TPM-ish ceiling", () => {
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

    assert.ok(
      packed.body.length <= PROVIDER_DIFF_BUDGETS.groq.maxBodyChars + 50,
    );
    assert.ok(packed.diff.length < 10_000);
  });

  it("packs prior-cited paths before other source files", () => {
    const files = [
      {
        filename: "src/a.ts",
        status: "modified",
        patch: `@@\n${"a".repeat(900)}\n`,
      },
      {
        filename: "apps/api/src/orgs/orgs.service.ts",
        status: "modified",
        patch: `@@\n${"IMPORTANT_ORG_CODE".repeat(20)}\n`,
      },
      {
        filename: "src/b.ts",
        status: "modified",
        patch: `@@\n${"b".repeat(900)}\n`,
      },
    ];

    const packed = packPullContext(
      files,
      "body",
      { maxTotalChars: 1_200, maxPerFileChars: 800, maxBodyChars: 100 },
      false,
      new Set(["apps/api/src/orgs/orgs.service.ts"]),
    );

    assert.match(packed.diff, /IMPORTANT_ORG_CODE/);
    const orgIdx = packed.diff.indexOf("orgs.service.ts");
    const aIdx = packed.diff.indexOf("src/a.ts");
    assert.ok(orgIdx >= 0);
    if (aIdx >= 0) assert.ok(orgIdx < aIdx);
  });

  it("packs deleted high-signal files before same-tier small touches", () => {
    const files = [
      {
        filename: "src/util.ts",
        status: "modified",
        patch: "@@\n+const x = 1;\n",
      },
      {
        filename: "apps/api/src/config/env.ts",
        status: "removed",
        patch: "@@\n-export const STRIPE_SECRET_KEY = \"\";\n",
      },
      {
        filename: "apps/api/src/billing/billing.controller.ts",
        status: "removed",
        patch: "@@\n-@Post('checkout')\n-checkout() {}\n",
      },
      {
        filename: "src/tiny.ts",
        status: "modified",
        patch: "@@\n+noop\n",
      },
    ];

    const packed = packPullContext(files, "body", {
      maxTotalChars: 1_400,
      maxPerFileChars: 600,
      maxBodyChars: 100,
    });

    const envIdx = packed.diff.indexOf("config/env.ts");
    const ctrlIdx = packed.diff.indexOf("billing.controller.ts");
    const utilIdx = packed.diff.indexOf("src/util.ts");
    assert.ok(envIdx >= 0);
    assert.ok(ctrlIdx >= 0);
    assert.ok(envIdx < utilIdx || utilIdx < 0);
    assert.ok(ctrlIdx < utilIdx || utilIdx < 0);
    assert.ok(packed.includedFilenames.includes("apps/api/src/config/env.ts"));
    assert.ok(
      packed.includedFilenames.includes(
        "apps/api/src/billing/billing.controller.ts",
      ),
    );
  });
});

describe("splitPatchHunks", () => {
  it("splits on @@ headers", () => {
    const hunks = splitPatchHunks(
      "@@ -1,2 +1,2 @@\n-a\n+b\n@@ -40,2 +40,3 @@\n+c\n+d\n",
    );
    assert.equal(hunks.length, 2);
    assert.equal(hunks[1]!.added, 2);
  });

  it("treats a headerless patch as one block", () => {
    const hunks = splitPatchHunks("@@\ncode\nmore code\n");
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0]!.added, 0);
  });
});

describe("selectPatchHunks", () => {
  it("keeps added-code hunks instead of slicing the top of the patch", () => {
    // Reproduction of the git-with-it#1 miss: the fix lives in a later hunk of a
    // file whose patch is far larger than the per-file budget.
    const filler = Array.from(
      { length: 60 },
      (_, i) => ` context line ${i} ${"x".repeat(40)}`,
    ).join("\n");
    const patch = `@@ -1,60 +1,60 @@\n${filler}\n@@ -200,3 +200,4 @@\n+    return db.transaction((tx) => this.provisionPersonalWorkspace(userId, opts, tx));\n+    const slug = await this.uniqueSlug(baseSlug, tx);\n`;

    const packed = packPullContext(
      [
        {
          filename: "apps/api/src/orgs/orgs.service.ts",
          status: "modified",
          patch,
        },
      ],
      "body",
      { maxTotalChars: 4_000, maxPerFileChars: 1_500, maxBodyChars: 200 },
    );

    assert.ok(patch.length > 3_000);
    assert.match(packed.diff, /db\.transaction/);
    assert.match(packed.diff, /provisionPersonalWorkspace/);
    assert.match(packed.diff, /\[partial: 1 of 2 hunks\]/);
    assert.match(packed.diff, /1 hunk not shown/);
    assert.ok(packed.diff.length < 2_500);
  });

  it("reports which hunk numbers were kept", () => {
    const selection = selectPatchHunks(
      `@@ -1,2 +1,2 @@\n${"x".repeat(900)}\n@@ -50,2 +50,3 @@\n+const fixed = true;\n+await retry();\n`,
      600,
    );
    assert.equal(selection.hunksTotal, 2);
    assert.equal(selection.hunksShown, 1);
    assert.deepEqual(selection.shownNumbers, [2]);
    assert.equal(selection.clipped, true);
    assert.match(selection.text, /const fixed = true;/);
  });

  it("reports partial coverage instead of claiming the file was reviewed", () => {
    const files = [
      {
        filename: "apps/api/src/orgs/orgs.service.ts",
        status: "modified",
        patch: `@@ -1,3 +1,3 @@\n${"line\n".repeat(200)}`,
      },
      {
        filename: "apps/api/src/db/schema.ts",
        status: "modified",
        patch: `@@ -1,3 +1,3 @@\n${"line\n".repeat(200)}`,
      },
    ];

    const packed = packPullContext(files, "body", {
      maxTotalChars: 2_000,
      maxPerFileChars: 600,
      maxBodyChars: 200,
    });

    assert.equal(packed.partialFiles.length, 2);
    assert.equal(
      packed.partialFiles[0]!.totalChars > packed.partialFiles[0]!.shownChars,
      true,
    );
    assert.match(packed.diff, /Partially shown files/);
    assert.match(packed.diff, /NOT proof that it is missing/);
    assert.equal(packed.shownPatchChars < packed.totalPatchChars, true);
    assert.equal(packed.totalPatchChars > 0, true);
  });
});
