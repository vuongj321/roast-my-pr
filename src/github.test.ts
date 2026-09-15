import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isRoastBotComment,
  selectLatestPriorRoast,
  selectLatestPriorRoastComment,
} from "./github.js";
import { ROAST_FOOTER_MARKER, buildRoastFooter, readRoastState } from "./prompts.js";
import type { RoastState } from "./types.js";

describe("isRoastBotComment", () => {
  it("detects footer-marked roast comments", () => {
    const body = `Some roast text${buildRoastFooter("gemini-3.6-flash")}`;
    assert.equal(isRoastBotComment(body), true);
    assert.ok(body.includes(ROAST_FOOTER_MARKER));
  });

  it("rejects non-roast comments", () => {
    assert.equal(isRoastBotComment("/roastmypr"), false);
    assert.equal(isRoastBotComment("nice PR"), false);
    assert.equal(isRoastBotComment(null), false);
    assert.equal(isRoastBotComment(undefined), false);
  });
});

describe("selectLatestPriorRoastComment", () => {
  it("returns the comment id alongside the body so state can be read", () => {
    const state: RoastState = {
      v: 1,
      sha: "d63231d42ba562440d6812538ec72a2160ba37d1",
      findings: [{ id: "F1", text: "- No transaction around provisioning." }],
    };
    const picked = selectLatestPriorRoastComment([
      { id: 1, body: "/roastmypr" },
      { id: 2, body: `older${buildRoastFooter("groq")}` },
      { id: 4, body: `newer${buildRoastFooter("gemini-3.6-flash", state)}` },
    ]);

    assert.ok(picked);
    assert.equal(picked!.id, 4);
    const parsed = readRoastState(picked!.body);
    assert.equal(parsed!.sha, state.sha);
  });

  it("returns null when nothing is footer-marked or it is excluded", () => {
    assert.equal(selectLatestPriorRoastComment([{ id: 1, body: "lgtm" }]), null);
    assert.equal(
      selectLatestPriorRoastComment(
        [{ id: 9, body: `roast${buildRoastFooter("groq")}` }],
        9,
      ),
      null,
    );
  });
});

describe("selectLatestPriorRoast (deprecated wrapper)", () => {
  it("returns null when there are no roast comments", () => {
    assert.equal(
      selectLatestPriorRoast([
        { id: 1, body: "/roastmypr" },
        { id: 2, body: "lgtm" },
      ]),
      null,
    );
  });

  it("returns the latest roast when multiple exist", () => {
    const first = `First roast${buildRoastFooter("gemini-3.6-flash")}`;
    const second = `Second roast${buildRoastFooter("@cf/zai-org/glm-4.7-flash")}`;
    const picked = selectLatestPriorRoast([
      { id: 1, body: "/roastmypr" },
      { id: 2, body: first },
      { id: 3, body: "ack" },
      { id: 4, body: second },
    ]);
    assert.equal(picked, second.trim());
  });

  it("excludes a comment id (e.g. the triggering comment)", () => {
    const roast = `Only roast${buildRoastFooter("gemini-3.6-flash")}`;
    assert.equal(
      selectLatestPriorRoast([{ id: 99, body: roast }], 99),
      null,
    );
    assert.equal(
      selectLatestPriorRoast(
        [
          { id: 1, body: roast },
          { id: 99, body: `Newer${buildRoastFooter("groq")}` },
        ],
        99,
      ),
      roast.trim(),
    );
  });
});
