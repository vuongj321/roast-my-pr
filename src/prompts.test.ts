import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_PRIOR_ROAST_CHARS,
  ROAST_SYSTEM_PROMPT,
  buildPartialReviewNote,
  buildRoastFooter,
  buildUserPrompt,
  parseFindingsFromRoast,
  readRoastState,
  stripRoastFooter,
  truncatePriorRoast,
} from "./prompts.js";
import type { RoastState } from "./types.js";

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

  it("includes author commit subjects as stated intent", () => {
    const prompt = buildUserPrompt({
      ...basePromptInput,
      commitMessages: [
        "refactor: drop dead queues",
        "chore(db): keep unused enum values — Postgres cannot drop them",
      ],
    });
    assert.match(prompt, /Author commits \(stated intent\)/);
    assert.match(prompt, /Postgres cannot drop them/);
    assert.match(prompt, /deliberate tradeoffs/);
  });

  it("adds low-coverage claim discipline when the pack is truncated", () => {
    const prompt = buildUserPrompt({
      ...basePromptInput,
      truncated: true,
      includedFiles: 5,
      totalFiles: 48,
    });
    assert.match(prompt, /LOW COVERAGE RULES/);
    assert.match(prompt, /not in the packed slice/);
  });
});

describe("ROAST_SYSTEM_PROMPT", () => {
  it("keeps soft prior-roast rules without Evidence requirements", () => {
    assert.match(ROAST_SYSTEM_PROMPT, /hypotheses to re-check/);
    assert.match(ROAST_SYSTEM_PROMPT, /already present in the packed diff/);
    assert.doesNotMatch(ROAST_SYSTEM_PROMPT, /Evidence:/);
  });

  it("forbids absence claims and repeat-raises", () => {
    assert.match(ROAST_SYSTEM_PROMPT, /Absence is not evidence/);
    assert.match(ROAST_SYSTEM_PROMPT, /author answering you/);
    assert.match(
      ROAST_SYSTEM_PROMPT,
      /Never raise a finding you yourself marked resolved/,
    );
  });

  it("treats commit subjects as intent and bans hedge closers", () => {
    assert.match(ROAST_SYSTEM_PROMPT, /commit subjects as stated intent/);
    assert.match(ROAST_SYSTEM_PROMPT, /append-only/);
    assert.match(ROAST_SYSTEM_PROMPT, /grain of salt/);
    assert.match(ROAST_SYSTEM_PROMPT, /leftovers and type drift/);
    assert.doesNotMatch(ROAST_SYSTEM_PROMPT, /A "Fix it" section/);
    assert.match(ROAST_SYSTEM_PROMPT, /Each bullet names an issue only/);
  });
});

const STATE: RoastState = {
  v: 1,
  sha: "d63231d42ba562440d6812538ec72a2160ba37d1",
  findings: [
    {
      id: "F1",
      path: "apps/api/src/orgs/orgs.service.ts",
      text: "- Provisioning runs without a transaction.",
    },
  ],
};

describe("review state footer", () => {
  it("round-trips state (sha + findings) through the footer", () => {
    const body = `Roast text${buildRoastFooter("gemini-3.6-flash", STATE)}`;
    const parsed = readRoastState(body);

    assert.ok(parsed);
    assert.equal(parsed.sha, STATE.sha);
    assert.deepEqual(parsed.findings, STATE.findings);
    assert.match(body, /Reviewed by \*\*Roast my PR\*\*/);
  });

  it("survives finding text containing -->", () => {
    const state: RoastState = {
      v: 1,
      findings: [{ id: "F1", text: "guard the --> arrow case in the parser" }],
    };
    const body = buildRoastFooter("openai/gpt-oss-20b", state);

    assert.equal(
      readRoastState(body)!.findings[0]!.text,
      "guard the --> arrow case in the parser",
    );
  });

  it("returns null for missing or malformed state", () => {
    assert.equal(readRoastState(null), null);
    assert.equal(readRoastState("plain roast with no footer"), null);
    assert.equal(readRoastState("<!-- roastmypr-state {nope} -->"), null);
  });

  it("strips the footer and state from prior text", () => {
    const body = `Real roast body${buildRoastFooter("groq", STATE)}`;
    assert.equal(stripRoastFooter(body), "Real roast body");
  });

  it("renders the coverage note under the attribution, not above the roast", () => {
    const note = buildPartialReviewNote({
      includedFiles: 6,
      totalFiles: 25,
      shownChars: 7_000,
      totalChars: 71_000,
    })!;
    const body = `Real roast body${buildRoastFooter("groq", STATE, note)}`;

    const attribution = body.indexOf("Reviewed by **Roast my PR**");
    assert.ok(attribution > -1);
    assert.ok(body.indexOf(note) > attribution);
    assert.ok(body.startsWith("Real roast body"));
    // The next run still reads the state, and neither footer part reaches the model.
    assert.equal(readRoastState(body)!.sha, STATE.sha);
    assert.equal(stripRoastFooter(body), "Real roast body");
  });

  it("drops prompt echoes stored by an earlier bad run", () => {
    const state: RoastState = {
      v: 1,
      sha: "731a1989d332e68e6073bfaac331c525f39d12af",
      findings: [
        { id: "F1", text: "* PR Title: `feat(roast): add a paid provider`" },
        { id: "F2", text: "* Author: `@vuongj321`" },
        { id: "F3", path: "src/a.ts", text: "* `src/a.ts` never retries." },
        {
          id: "F4",
          path: "src/retry.ts",
          text: "- **Reviewing the retry loop:** `src/retry.ts` never resets.",
        },
      ],
    };
    const body = `Roast text${buildRoastFooter("gemma", state)}`;
    const parsed = readRoastState(body);

    assert.deepEqual(parsed!.findings, [
      { id: "F3", path: "src/a.ts", text: "* `src/a.ts` never retries." },
      {
        id: "F4",
        path: "src/retry.ts",
        text: "- **Reviewing the retry loop:** `src/retry.ts` never resets.",
      },
    ]);
  });
});

describe("parseFindingsFromRoast", () => {
  it("turns roast bullets into addressable findings", () => {
    const roast = `You shipped a thesaurus commit.

### What I'd send back
- The slug fallback in \`apps/api/src/orgs/orgs.service.ts\` never retries after a clash.
- Invite expiry is never enforced in \`apps/api/src/orgs/orgs.service.ts\`.

Grudging respect.
`;
    const findings = parseFindingsFromRoast(roast);

    assert.equal(findings.length, 2);
    assert.equal(findings[0]!.id, "F1");
    assert.equal(findings[0]!.path, "apps/api/src/orgs/orgs.service.ts");
    assert.match(findings[1]!.text, /Invite expiry/);
  });

  it("ignores planning labels and prompt echoes", () => {
    const dump = `### What I'd send back
* PR Title: \`feat(roast): add a paid provider\`
* Author: \`@vuongj321\`
* Key Changes:
* *Drafting the specific insults*:
* \`src/roast.ts\`: the attempts mapping is overkill.
- \`src/github.ts\`: MAX_PRIOR_ROAST_PAGES is arbitrary.`;

    const findings = parseFindingsFromRoast(dump);

    assert.deepEqual(
      findings.map((f) => f.text),
      [
        "* `src/roast.ts`: the attempts mapping is overkill.",
        "- `src/github.ts`: MAX_PRIOR_ROAST_PAGES is arbitrary.",
      ],
    );
  });

  it("keeps a finding that opens with a process word", () => {
    // Same predicate guards the footer state, so an over-broad label match used
    // to erase legitimate findings from review memory, not just from a reply.
    const roast = `### What I'd send back
- **Reviewing the retry loop:** \`src/retry.ts\` never resets the backoff.`;

    const findings = parseFindingsFromRoast(roast);

    assert.deepEqual(
      findings.map((f) => f.text),
      ["- **Reviewing the retry loop:** `src/retry.ts` never resets the backoff."],
    );
  });

  it("returns nothing for an empty or footer-only roast", () => {
    assert.deepEqual(parseFindingsFromRoast(""), []);
    assert.deepEqual(
      parseFindingsFromRoast(`x${buildRoastFooter("groq", STATE)}`),
      [],
    );
  });
});

describe("buildUserPrompt review state", () => {
  it("includes prior findings, the accounting contract and the delta", () => {
    const prompt = buildUserPrompt({
      ...basePromptInput,
      priorRoast: "old roast prose",
      reviewedSha: STATE.sha,
      priorFindings: STATE.findings,
      reviewDelta: {
        diff: "+    return db.transaction((tx) => this.provision(tx));",
        commits: 2,
        files: ["apps/api/src/orgs/orgs.service.ts"],
        truncated: false,
      },
    });

    assert.match(prompt, /Prior findings to account for \(from review of d63231d\)/);
    assert.match(prompt, /F1 \[apps\/api\/src\/orgs\/orgs\.service\.ts\]/);
    assert.match(prompt, /F1 resolved/);
    assert.match(prompt, /Changes pushed since that review \(2 commits/);
    assert.match(prompt, /db\.transaction\(\(tx\) => this\.provision\(tx\)\)/);
    assert.doesNotMatch(prompt, /Reviewed by \*\*Roast my PR\*\*/);
  });

  it("warns when files are only partially shown", () => {
    const prompt = buildUserPrompt({
      ...basePromptInput,
      partialFiles: [
        {
          filename: "apps/api/src/orgs/orgs.service.ts",
          shownChars: 1_502,
          totalChars: 12_313,
          hunksShown: 1,
          hunksTotal: 8,
        },
      ],
    });

    assert.match(prompt, /only PARTIALLY shown/);
    assert.match(prompt, /1\/8 hunks/);
    assert.match(prompt, /NOT evidence that it is missing/);
  });

  it("omits the delta and findings sections when there is nothing to say", () => {
    const prompt = buildUserPrompt(basePromptInput);
    assert.doesNotMatch(prompt, /Changes pushed since that review/);
    assert.doesNotMatch(prompt, /Prior findings to account for/);
    assert.doesNotMatch(prompt, /PARTIALLY shown/);
  });
});

describe("truncatePriorRoast tail", () => {
  it("keeps the end of a long prior roast", () => {
    const long = `${"headline words ".repeat(400)}TAIL_CLOSER_LINE`;
    const out = truncatePriorRoast(long);

    assert.ok(out.length <= MAX_PRIOR_ROAST_CHARS);
    assert.match(out, /prior roast truncated/);
    assert.match(out, /TAIL_CLOSER_LINE/);
  });
});

describe("buildPartialReviewNote", () => {
  it("is silent for small PRs and healthy full coverage", () => {
    assert.equal(
      buildPartialReviewNote({
        includedFiles: 2,
        totalFiles: 3,
        shownChars: 100,
        totalChars: 1_000,
      }),
      null,
    );
    assert.equal(
      buildPartialReviewNote({
        includedFiles: 18,
        totalFiles: 25,
        shownChars: 71_000,
        totalChars: 71_000,
      }),
      null,
    );
  });

  it("labels the run when the fallback budget covered a sliver of the PR", () => {
    const note = buildPartialReviewNote({
      includedFiles: 6,
      totalFiles: 25,
      shownChars: 7_000,
      totalChars: 71_000,
    });

    assert.ok(note);
    assert.match(note!, /6 of 25 changed files/);
    assert.match(note!, /~10% of the diff text/);
  });

  it("banners truncated packs even when file ratio looks healthy", () => {
    const note = buildPartialReviewNote(
      {
        includedFiles: 18,
        totalFiles: 25,
        shownChars: 45_000,
        totalChars: 71_000,
      },
      { truncated: true },
    );
    assert.ok(note);
    assert.match(note!, /18 of 25 changed files/);
  });

  it("uses a louder banner for non-Gemini fallbacks", () => {
    const note = buildPartialReviewNote(
      {
        includedFiles: 6,
        totalFiles: 25,
        shownChars: 7_000,
        totalChars: 71_000,
      },
      { provider: "groq" },
    );
    assert.ok(note);
    assert.match(note!, /fallback model \(`groq`\)/);
    assert.match(note!, /Claims outside the packed slice are unverified/);
  });

  it("does not call the paid provider a fallback model", () => {
    const note = buildPartialReviewNote(
      {
        includedFiles: 6,
        totalFiles: 25,
        shownChars: 7_000,
        totalChars: 71_000,
      },
      { provider: "openai" },
    );
    assert.ok(note);
    assert.match(note!, /^_Partial review: only 6 of 25 changed files/);
    assert.doesNotMatch(note!, /fallback model/);
  });
});

