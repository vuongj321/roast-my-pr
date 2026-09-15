import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INCOMPLETE_PACK_NOTE,
  PATH_STRIPPED_NOTE,
  bulletPathsArePacked,
  filterRoastByPackedPaths,
} from "./pathFilter.js";

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
