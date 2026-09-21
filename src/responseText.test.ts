import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractModelText,
  isPlanningDump,
  isPlanningLabel,
  isPostableRoast,
  isTruncatedRoastText,
  isUsableRoastText,
  logRejectedAnswer,
  looksLikeFinishedRoast,
  rawAnswerText,
} from "./responseText.js";

const FINISHED = `# Headline

### What I'd send back
* bug in \`src/a.ts\`

### Fix it
1. Fix it

Closer.`;

describe("extractModelText", () => {
  it("reads Workers AI response field", () => {
    assert.equal(extractModelText({ response: FINISHED }), FINISHED);
  });

  it("reads OpenAI message.content string", () => {
    assert.equal(
      extractModelText({
        choices: [{ message: { role: "assistant", content: FINISHED } }],
      }),
      FINISHED,
    );
  });

  it("prefers message.content over response when both exist", () => {
    assert.equal(
      extractModelText({
        response: "wrong top-level without structure",
        choices: [{ message: { content: FINISHED } }],
      }),
      FINISHED,
    );
  });

  it("reads content part arrays", () => {
    assert.equal(
      extractModelText({
        choices: [
          {
            message: {
              content: [
                { type: "text", text: "# H\n\n### What I'd send back\n" },
                { text: "* bug in `src/a.ts`\n\nCloser." },
              ],
            },
          },
        ],
      }),
      "# H\n\n### What I'd send back\n* bug in `src/a.ts`\n\nCloser.",
    );
  });

  it("ignores planning-only reasoning fields", () => {
    assert.equal(
      extractModelText({
        choices: [
          {
            message: {
              content: "",
              reasoning: "We need to produce a roast review. Let's scan diff.",
            },
          },
        ],
      }),
      "",
    );
  });

  it("accepts reasoning only when it looks like a finished roast", () => {
    assert.equal(
      extractModelText({
        choices: [
          {
            message: {
              content: null,
              reasoning: FINISHED,
            },
          },
        ],
      }),
      FINISHED,
    );
  });

  it("returns empty for blank payloads", () => {
    assert.equal(
      extractModelText({ choices: [{ message: { content: "  " } }] }),
      "",
    );
    assert.equal(extractModelText(null), "");
    assert.equal(extractModelText({}), "");
  });
});

describe("isUsableRoastText", () => {
  it("accepts a normal roast", () => {
    assert.equal(isUsableRoastText(FINISHED), true);
  });

  it("rejects GLM chain-of-thought dumps", () => {
    const cot = `1. **Analyze the Request:**
* **Role:** "Roast my PR"
### What I'd send back
* **Constraint 4:** Re-check previous review.
2. **Review the Diff (Mental Scan for Issues):**
* something
4. **Drafting the Response:**
* Headline draft`;
    assert.equal(isUsableRoastText(cot), false);
  });

  it("rejects Groq planning dumps", () => {
    assert.equal(
      isUsableRoastText(
        "We need to produce a roast review. Must include headline. Let's scan diff.",
      ),
      false,
    );
  });
});

describe("looksLikeFinishedRoast", () => {
  it("requires send-back structure", () => {
    assert.equal(looksLikeFinishedRoast(FINISHED), true);
    assert.equal(looksLikeFinishedRoast("just some thoughts"), false);
  });
});

describe("isTruncatedRoastText", () => {
  it("flags mid-sentence cuts like the Gemini PR comment", () => {
    assert.equal(
      isTruncatedRoastText(
        "### What I'd send back\n* **`register-user.ts`**: You moved registration writes into `db.transaction()`, but",
      ),
      true,
    );
    assert.equal(
      isTruncatedRoastText(
        "Use `db.transaction()` in `provisionPersonalWorkspace()` and `register",
      ),
      true,
    );
  });

  it("accepts complete closers", () => {
    assert.equal(
      isTruncatedRoastText("Ship it after you fix the race. Reluctantly."),
      false,
    );
  });
});

/**
 * Excerpted verbatim from the comment the bot posted on PR #4: Gemma's planning
 * notes, published as the roast. Note that it *does* carry a real
 * "What I'd send back" heading — the structure check alone never stopped it.
 */
const PR4_PLANNING_DUMP = `*   PR Title: \`feat(roast): add an optional paid OpenAI-compatible provider\`
    *   Author: \`@vuongj321\`
    *   Summary: Adds OpenAI-compatible provider support (highest priority).
    *   Key Changes:
        *   \`src/roast.ts\`: Added \`openaiBaseUrl\`, \`isOpenAiEnabled\`, \`PROVIDER_PRIORITY\`.

    *   *Reviewing the "Fix it" items*:
        *   The \`openaiMaxTokensField\` logic: it works.

### What I'd send back
*   \`src/roast.ts\`: The \`attempts\` mapping in \`generateRoast\` is overkill.

*   *Drafting the specific insults*:
- \`src/roast.ts\`: "You're running all provider builders even if they're disabled."
- \`src/prompts.ts\`: "Hardcoding \`FALLBACK_PROVIDERS\` as a \`Set\` is a manual labor tax."
*   *Refining "Fix it"*:
1. Replace the arbitrary page cap in \`src/github.ts\`.
*   *Closer*: "The GitHub fix is a band-aid, but the OpenAI integration is actually usable."
*   *Wait, check the \`generateRoast\` logic again*:
        Actually, it's not that bad. It's very readable. I'll focus on the builder execution.`;

describe("planning dumps", () => {
  it("rejects the dump that was posted on PR #4", () => {
    assert.equal(isPlanningDump(PR4_PLANNING_DUMP), true);
    assert.equal(isUsableRoastText(PR4_PLANNING_DUMP), false);
    assert.equal(isPostableRoast(PR4_PLANNING_DUMP), false);
    assert.equal(extractModelText({ response: PR4_PLANNING_DUMP }), "");
    assert.equal(
      extractModelText({
        choices: [{ message: { content: PR4_PLANNING_DUMP } }],
      }),
      "",
    );
  });

  it("keeps the rejected text available for logs", () => {
    assert.match(
      rawAnswerText({ response: PR4_PLANNING_DUMP }),
      /Drafting the specific insults/,
    );
  });

  it("still uses a usable field when another one is a dump", () => {
    assert.equal(
      extractModelText({
        response: FINISHED,
        choices: [{ message: { content: PR4_PLANNING_DUMP } }],
      }),
      FINISHED,
    );
  });

  it("keeps legitimate category labels and lead-in bullets", () => {
    const roast = `# A thesaurus commit

### What I'd send back
- **Bug:** \`src/db.ts\` swallows the conflict error.
* \`src/db.ts\`:
  - the retry loop can double-insert

### Fix it
1. Catch the unique violation.
`;
    assert.equal(isPlanningDump(roast), false);
    assert.equal(isPostableRoast(roast), true);
  });

  it("rejects a bullet that is nothing but a process label", () => {
    assert.equal(isPlanningLabel("* *Drafting the specific insults*:"), true);
    assert.equal(isPlanningLabel("- Key Changes:"), true);
    assert.equal(isPlanningDump("* *Drafting the specific insults*:"), true);
    assert.equal(
      isPlanningDump("- *Drafting the specific insults*:\n- *Closer*:"),
      true,
    );
  });

  it("needs two independent signals before calling a reply scratchpad", () => {
    const oneLabel =
      "* Drafting the specific insults*: the rename does nothing useful.";
    assert.equal(isPlanningDump(oneLabel), false);
    assert.equal(isPlanningDump(`${oneLabel}\n* *Closer*: "Ship it."`), true);
    assert.equal(isPlanningDump(`${oneLabel}\nActually, it's not that bad.`), true);
  });

  it("keeps a labelled finding that opens with a process word", () => {
    // The PR #4 review's own example: one process word on a bullet that carries
    // a finding is not scratchpad, and rejecting it costs a paid answer.
    const roast = `# Your retry loop is a coin flip

### What I'd send back
- **Reviewing the retry loop:** \`src/retry.ts\` never resets the backoff after a 429.

### Fix it
1. Reset the backoff once a call succeeds.

Ship it after the backoff resets.`;

    assert.equal(
      isPlanningLabel(
        "- **Reviewing the retry loop:** `src/retry.ts` never resets the backoff.",
      ),
      false,
    );
    assert.equal(isPlanningDump(roast), false);
    assert.equal(isPostableRoast(roast), true);
  });
});

describe("logRejectedAnswer", () => {
  it("logs the text that was thrown away, with the reason", () => {
    const logged: string[] = [];
    const realConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.join(" "));
    };
    try {
      logRejectedAnswer(
        "OpenAI",
        "returned planning notes, not a roast",
        "* Drafting the specific insults*: the rename does nothing.",
        { choices: [] },
      );
      logRejectedAnswer("Gemini", "returned an empty roast", "", {
        candidates: [],
        promptFeedback: { blockReason: "SAFETY" },
      });
    } finally {
      console.error = realConsoleError;
    }

    assert.match(logged[0]!, /planning notes, not a roast/);
    assert.match(logged[0]!, /Drafting the specific insults/);
    assert.match(logged[1]!, /\[no answer text\]/);
    assert.match(logged[1]!, /SAFETY/);
  });
});

describe("isPostableRoast", () => {
  it("requires a structured review, not a chat summary", () => {
    assert.equal(isPostableRoast(FINISHED), true);
    assert.equal(isPostableRoast("Sure! Here's a summary of the PR."), false);
    assert.equal(isPostableRoast(""), false);
  });

  it("rejects a roast cut off mid-bullet", () => {
    assert.equal(
      isPostableRoast(
        "### What I'd send back\n* **`register-user.ts`**: You moved registration writes into `db.transaction()`, but",
      ),
      false,
    );
  });

  it("is what extractModelText applies to content", () => {
    assert.equal(
      extractModelText({
        choices: [{ message: { content: "Sure! Here's a summary." } }],
      }),
      "",
    );
  });
});
