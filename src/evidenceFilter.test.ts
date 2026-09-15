import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  STRIPPED_NOTE,
  UNSUBSTANTIATED_FALLBACK,
  evidenceAppearsInDiff,
  extractEvidenceQuote,
  filterRoastByEvidence,
} from "./evidenceFilter.js";

const PACKED = `
--- apps/api/src/orgs/orgs.service.ts (modified)
+ return db.transaction(async (tx) => {
+   await tx.update(orgInvites).set({ status: 'revoked' })
+ });
`;

describe("evidenceAppearsInDiff", () => {
  it("matches whitespace-normalized substrings", () => {
    assert.equal(
      evidenceAppearsInDiff("return db.transaction", PACKED),
      true,
    );
    assert.equal(
      evidenceAppearsInDiff("return   db.transaction", PACKED),
      true,
    );
  });

  it("rejects short or missing quotes", () => {
    assert.equal(evidenceAppearsInDiff("tx", PACKED), false);
    assert.equal(evidenceAppearsInDiff("for loop UPDATE each row", PACKED), false);
  });
});

describe("extractEvidenceQuote", () => {
  it("reads Evidence backticks", () => {
    assert.equal(
      extractEvidenceQuote("- Foo. Evidence: `return db.transaction`"),
      "return db.transaction",
    );
  });
});

describe("filterRoastByEvidence", () => {
  it("keeps bullets with matching evidence and drops others", () => {
    const roast = `Nested nonsense.

### What I'd send back
- Real issue in provisioning. Evidence: \`return db.transaction\`
- Fake N+1 loop. Evidence: \`for (const invite of pending)\`
- No evidence at all about seeds.

### Fix it
1. Keep using the transaction you already have. Evidence: \`await tx.update(orgInvites)\`
2. Invented fix. Evidence: \`nested transaction is not allowed\`

Ship it or don't.
`;

    const { text, kept, dropped } = filterRoastByEvidence(roast, PACKED);
    assert.ok(kept >= 2);
    assert.ok(dropped >= 2);
    assert.match(text, /Real issue/);
    assert.match(text, /Keep using the transaction/);
    assert.doesNotMatch(text, /Fake N\+1/);
    assert.doesNotMatch(text, /No evidence at all/);
    assert.doesNotMatch(text, /Invented fix/);
    assert.match(text, /Ship it or don't/);
  });

  it("returns fallback when nothing verifies", () => {
    const roast = `### What I'd send back
- Invented. Evidence: \`totally not in the diff ever\``;
    const { text, kept } = filterRoastByEvidence(roast, PACKED);
    assert.equal(kept, 0);
    assert.equal(text, UNSUBSTANTIATED_FALLBACK);
  });

  it("notes when fewer than two bullets survive", () => {
    const roast = `### What I'd send back
- Only one real hit. Evidence: \`return db.transaction\`
- Bogus. Evidence: \`nope nope nope\``;
    const { text, kept } = filterRoastByEvidence(roast, PACKED);
    assert.equal(kept, 1);
    assert.ok(text.startsWith(STRIPPED_NOTE));
  });
});
