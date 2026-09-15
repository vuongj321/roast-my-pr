import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractModelText,
  isTruncatedRoastText,
  isUsableRoastText,
  looksLikeFinishedRoast,
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
