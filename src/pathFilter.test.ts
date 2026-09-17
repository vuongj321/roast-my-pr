import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ABSOLUTE_CLAIM_STRIPPED_NOTE,
  INTENT_FIXIT_STRIPPED_NOTE,
  INCOMPLETE_PACK_NOTE,
  PATH_STRIPPED_NOTE,
  absoluteClaimHasPackedEvidence,
  bulletPathsArePacked,
  bulletRepeatsFinding,
  dropIntentContradictingFixIts,
  dropResolvedRepeats,
  filterRoastByPackedPaths,
  filterUnverifiedAbsoluteClaims,
  parseFindingAccounting,
  stripHedgeCloser,
} from "./pathFilter.js";
import type { FindingStatus, PriorFinding } from "./types.js";

const PACKED = new Set([
  "apps/api/src/orgs/orgs.service.ts",
  "apps/api/src/auth/auth.controller.ts",
]);

describe("bulletPathsArePacked", () => {
  it("allows bullets with no path citations", () => {
    assert.equal(bulletPathsArePacked("- Vague complaint about naming", PACKED), true);
  });

  it("allows bullets that cite packed files", () => {
    assert.equal(
      bulletPathsArePacked(
        "- Bug in `apps/api/src/orgs/orgs.service.ts` around invites",
        PACKED,
      ),
      true,
    );
  });

  it("rejects bullets that cite unpacked files", () => {
    assert.equal(
      bulletPathsArePacked(
        "- N+1 in `apps/api/src/seed.ts` when creating demo",
        PACKED,
      ),
      false,
    );
  });
});

describe("filterRoastByPackedPaths", () => {
  it("keeps packed-path bullets and drops unpacked ones", () => {
    const roast = `Headline about the PR.

### What I'd send back
- Real issue in \`apps/api/src/orgs/orgs.service.ts\`
- Invented file \`apps/web/src/missing.tsx\` is broken

### Fix it
1. Fix orgs in \`apps/api/src/orgs/orgs.service.ts\`
2. Touch \`apps/web/src/missing.tsx\`

Closer line.
`;
    const { text, kept, dropped } = filterRoastByPackedPaths(roast, PACKED);
    assert.ok(kept >= 2);
    assert.ok(dropped >= 2);
    assert.match(text, /Real issue/);
    assert.match(text, /Fix orgs/);
    assert.doesNotMatch(text, /missing\.tsx/);
    assert.match(text, /Closer line/);
    assert.match(text, new RegExp(PATH_STRIPPED_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("posts incomplete note when every bullet cites unpacked paths", () => {
    const roast = `### What I'd send back
- Only \`apps/web/src/missing.tsx\`

### Fix it
1. Also \`apps/web/src/other.tsx\`
`;
    const { text, kept, dropped } = filterRoastByPackedPaths(roast, PACKED);
    assert.equal(kept, 0);
    assert.ok(dropped >= 1);
    assert.match(text, new RegExp(INCOMPLETE_PACK_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("leaves unstructured roasts alone", () => {
    const roast = "Just a freeform paragraph with no sections.";
    const { text, dropped } = filterRoastByPackedPaths(roast, PACKED);
    assert.equal(dropped, 0);
    assert.equal(text, roast);
  });
});

const PRIOR_FINDINGS: PriorFinding[] = [
  {
    id: "F1",
    path: "apps/api/src/orgs/orgs.service.ts",
    text: "- The slug collision fallback in `apps/api/src/orgs/orgs.service.ts` never retries after a clash.",
  },
  {
    id: "F2",
    path: "apps/api/src/orgs/orgs.service.ts",
    text: "- Invite expiry is never enforced in `apps/api/src/orgs/orgs.service.ts`.",
  },
];

describe("parseFindingAccounting", () => {
  it("extracts statuses and strips the bookkeeping lines", () => {
    const roast = `- F1 resolved
- F2 still present — "+    const [user] = await tx.insert(users)"
### Prior findings
- F3 unverifiable (the code is not in the packed diff)

You shipped a thesaurus commit.

### What I'd send back
- Real issue in \`apps/api/src/orgs/orgs.service.ts\`
`;
    const { accounting, text } = parseFindingAccounting(roast);

    assert.equal(accounting.get("F1"), "resolved");
    assert.equal(accounting.get("F2"), "stillPresent");
    assert.equal(accounting.get("F3"), "unverifiable");
    assert.doesNotMatch(text, /F1 resolved/);
    assert.doesNotMatch(text, /F3 unverifiable/);
    assert.doesNotMatch(text, /^### Prior findings$/m);
    assert.match(text, /thesaurus commit/);
    assert.match(text, /Real issue/);
  });
});

describe("bulletRepeatsFinding", () => {
  it("matches the same complaint restated with the path stripped", () => {
    assert.equal(
      bulletRepeatsFinding(
        "- The slug collision fallback never retries after a clash in `apps/api/src/orgs/orgs.service.ts`.",
        PRIOR_FINDINGS[0]!,
      ),
      true,
    );
  });

  it("does not match a different complaint in the same file", () => {
    assert.equal(
      bulletRepeatsFinding(
        "- Invite expiry is never enforced in `apps/api/src/orgs/orgs.service.ts`.",
        PRIOR_FINDINGS[0]!,
      ),
      false,
    );
  });

  it("does not match a finding in a different file", () => {
    assert.equal(
      bulletRepeatsFinding(
        "- The slug collision fallback never retries after a clash in `apps/api/src/db/schema.ts`.",
        PRIOR_FINDINGS[0]!,
      ),
      false,
    );
  });
});

describe("dropResolvedRepeats", () => {
  it("drops a bullet the model itself marked resolved", () => {
    const accounting = new Map<string, FindingStatus>([["F1", "resolved"]]);
    const text = `### What I'd send back
- The slug collision fallback never retries after a clash in \`apps/api/src/orgs/orgs.service.ts\`.
- Invite expiry is never enforced in \`apps/api/src/orgs/orgs.service.ts\`.`;

    const { text: out, dropped } = dropResolvedRepeats(
      text,
      PRIOR_FINDINGS,
      accounting,
    );

    assert.equal(dropped, 1);
    assert.doesNotMatch(out, /slug collision fallback/);
    assert.match(out, /Invite expiry/);
  });

  it("keeps repeats of findings that are still open", () => {
    const accounting = new Map<string, FindingStatus>([["F1", "stillPresent"]]);
    const { dropped } = dropResolvedRepeats(
      "- The slug collision fallback never retries after a clash.",
      PRIOR_FINDINGS,
      accounting,
    );
    assert.equal(dropped, 0);
  });

  it("is a no-op without accounting or prior findings", () => {
    assert.equal(
      dropResolvedRepeats("x", PRIOR_FINDINGS, new Map()).dropped,
      0,
    );
    assert.equal(
      dropResolvedRepeats(
        "x",
        undefined,
        new Map<string, FindingStatus>([["F1", "resolved"]]),
      ).dropped,
      0,
    );
  });
});

describe("stripHedgeCloser", () => {
  it("removes a trailing hedge paragraph", () => {
    const roast = `Half-baked cleanup.

### What I'd send back
- Real bug in \`apps/api/src/config/env.ts\`

### Fix it
- Align the type with the returned object.

I'll take a pass when the code compiles and we need full context.`;
    const { text, stripped } = stripHedgeCloser(roast);
    assert.equal(stripped, true);
    assert.doesNotMatch(text, /when the code compiles/);
    assert.match(text, /Align the type/);
  });

  it("removes closers that punt to the rest of the diff", () => {
    const roast = `Messy state dump.

### Fix it
- Align the types.

You still have to read the rest of the diff to see the real problems.`;
    const { text, stripped } = stripHedgeCloser(roast);
    assert.equal(stripped, true);
    assert.doesNotMatch(text, /rest of the diff/);
    assert.match(text, /Align the types/);
  });

  it("keeps a closer that judges the code", () => {
    const roast = `Messy diff.

### Fix it
- Delete the orphan.

Ship it when the tests pass, not before.`;
    const { text, stripped } = stripHedgeCloser(roast);
    assert.equal(stripped, false);
    assert.match(text, /Ship it when the tests pass/);
  });
});

describe("filterUnverifiedAbsoluteClaims", () => {
  const packed = `
--- src/diffPack.ts (modified)
+function isAddedLine(line: string): boolean {
+  return line.startsWith("+") && !line.startsWith("+++");
+}
`;

  it("keeps absolute claims that quote packed code", () => {
    const roast = `Headline.

### What I'd send back
- \`isAddedLine\` never guards \`!line.startsWith("+++")\` wait it does: \`!line.startsWith("+++")\`

### Fix it
- Keep the guard.
`;
    const { text, dropped } = filterUnverifiedAbsoluteClaims(roast, packed);
    assert.equal(dropped, 0);
    assert.match(text, /isAddedLine/);
  });

  it("drops absolute claims with no packed quote", () => {
    const roast = `Headline.

### What I'd send back
- splitPatchHunks blindly trusts every + line with no guard against +++ headers.

### Fix it
- Add a guard.
`;
    const { text, dropped } = filterUnverifiedAbsoluteClaims(roast, packed);
    assert.ok(dropped >= 1);
    assert.match(text, new RegExp(ABSOLUTE_CLAIM_STRIPPED_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(text, /blindly trusts/);
  });

  it("exports absoluteClaimHasPackedEvidence for unit checks", () => {
    assert.equal(
      absoluteClaimHasPackedEvidence(
        '- never guards `!line.startsWith("+++")`',
        packed,
      ),
      true,
    );
    assert.equal(
      absoluteClaimHasPackedEvidence("- never guards against +++ headers", packed),
      false,
    );
  });
});

describe("dropIntentContradictingFixIts", () => {
  it("drops Fix-its that undo footer-state constraints from commits", () => {
    const roast = `Headline.

### What I'd send back
- The footer carries state.

### Fix it
- Remove the hidden roastmypr-state comment and serialize in a dedicated JSON block.
- Align the types with the returned object.
`;
    const { text, dropped } = dropIntentContradictingFixIts(roast, [
      "feat(roast): remember findings in footer — no KV binding needed",
      "docs: document hidden state footer",
    ]);
    assert.equal(dropped, 1);
    assert.match(text, new RegExp(INTENT_FIXIT_STRIPPED_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(text, /Remove the hidden/);
    assert.match(text, /Align the types/);
  });

  it("is a no-op without constraint-like commits", () => {
    const roast = `Headline.

### Fix it
- Remove the hidden state comment.
`;
    const { dropped, text } = dropIntentContradictingFixIts(roast, [
      "feat: add widgets",
    ]);
    assert.equal(dropped, 0);
    assert.match(text, /Remove the hidden/);
  });
});
