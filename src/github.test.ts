import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchLatestPriorRoastComment,
  isRoastBotComment,
  selectLatestPriorRoast,
  selectLatestPriorRoastComment,
  truncateCommitSubject,
  commitSubjectsFromMessages,
  MAX_COMMIT_MESSAGES,
  MAX_PRIOR_ROAST_PAGES,
  MAX_COMMIT_SUBJECT_CHARS,
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
    const picked = selectLatestPriorRoastComment(
      [
        { id: 1, body: "/roastmypr" },
        { id: 2, body: `older${buildRoastFooter("groq")}` },
        { id: 4, body: `newer${buildRoastFooter("gemini-3.6-flash", state)}` },
      ],
      // REST default ordering: oldest first.
      "asc",
    );

    assert.ok(picked);
    assert.equal(picked!.id, 4);
    const parsed = readRoastState(picked!.body);
    assert.equal(parsed!.sha, state.sha);
  });

  it("returns null when nothing is footer-marked or it is excluded", () => {
    assert.equal(
      selectLatestPriorRoastComment([{ id: 1, body: "lgtm" }], "asc"),
      null,
    );
    assert.equal(
      selectLatestPriorRoastComment(
        [{ id: 9, body: `roast${buildRoastFooter("groq")}` }],
        "asc",
        9,
      ),
      null,
    );
  });
});

describe("selectLatestPriorRoast (deprecated wrapper)", () => {
  it("returns null when there are no roast comments", () => {
    assert.equal(
      selectLatestPriorRoast(
        [
          { id: 1, body: "/roastmypr" },
          { id: 2, body: "lgtm" },
        ],
        "asc",
      ),
      null,
    );
  });

  it("returns the latest roast when multiple exist", () => {
    const first = `First roast${buildRoastFooter("gemini-3.6-flash")}`;
    const second = `Second roast${buildRoastFooter("@cf/zai-org/glm-4.7-flash")}`;
    const picked = selectLatestPriorRoast(
      [
        { id: 1, body: "/roastmypr" },
        { id: 2, body: first },
        { id: 3, body: "ack" },
        { id: 4, body: second },
      ],
      "asc",
    );
    assert.equal(picked, second.trim());
  });

  it("excludes a comment id (e.g. the triggering comment)", () => {
    const roast = `Only roast${buildRoastFooter("gemini-3.6-flash")}`;
    assert.equal(
      selectLatestPriorRoast([{ id: 99, body: roast }], "asc", 99),
      null,
    );
    assert.equal(
      selectLatestPriorRoast(
        [
          { id: 1, body: roast },
          { id: 99, body: `Newer${buildRoastFooter("groq")}` },
        ],
        "asc",
        99,
      ),
      roast.trim(),
    );
  });
});

describe("commitSubjectsFromMessages", () => {
  it("keeps the first line and clips long subjects", () => {
    assert.equal(
      truncateCommitSubject("feat: add widgets\n\nLong body here"),
      "feat: add widgets",
    );
    const long = `x${"y".repeat(MAX_COMMIT_SUBJECT_CHARS)}`;
    const clipped = truncateCommitSubject(long);
    assert.ok(clipped.length <= MAX_COMMIT_SUBJECT_CHARS);
    assert.match(clipped, /…$/);
  });

  it("caps how many subjects are kept", () => {
    const messages = Array.from(
      { length: MAX_COMMIT_MESSAGES + 5 },
      (_, i) => `commit ${i}`,
    );
    const subjects = commitSubjectsFromMessages(messages);
    assert.equal(subjects.length, MAX_COMMIT_MESSAGES);
    assert.equal(subjects[0], "commit 0");
  });
});

describe("selectLatestPriorRoastComment order contract", () => {
  it("keeps the first match on a newest-first page", () => {
    const picked = selectLatestPriorRoastComment(
      [
        { id: 30, body: `newest${buildRoastFooter("groq")}` },
        { id: 20, body: `older${buildRoastFooter("gemini-3.6-flash")}` },
      ],
      "desc",
    );
    assert.equal(picked?.id, 30);
  });
});

describe("fetchLatestPriorRoastComment", () => {
  type Listed = { id: number; body: string | null };
  type RepoClient = Parameters<typeof fetchLatestPriorRoastComment>[0];

  const roastBody = (label: string) =>
    `${label}${buildRoastFooter("gemini-3.6-flash")}`;

  /** 100-comment pages of non-roast chatter, newest first. */
  const chatter = (start: number, count = 100): Listed[] =>
    Array.from({ length: count }, (_, i) => ({
      id: start + i,
      body: "chatter",
    }));

  function stubOctokit(pages: Listed[][]) {
    const calls: Array<{ page?: number; direction?: string }> = [];
    const octokit = {
      rest: {
        issues: {
          listComments: async (params: {
            page?: number;
            direction?: string;
          }) => {
            calls.push(params);
            return { data: pages[(params.page ?? 1) - 1] ?? [] };
          },
        },
      },
    };
    return { octokit: octokit as unknown as RepoClient, calls };
  }

  /** Run `fn`, returning its result plus every `console.error` line it wrote. */
  async function withConsoleError<T>(
    fn: () => Promise<T>,
  ): Promise<{ picked: T; logged: string[] }> {
    const logged: string[] = [];
    const realConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.join(" "));
    };
    try {
      return { picked: await fn(), logged };
    } finally {
      console.error = realConsoleError;
    }
  }

  it("asks for newest-first pages and returns the newest roast", async () => {
    const { octokit, calls } = stubOctokit([
      [{ id: 501, body: roastBody("newest") }, { id: 498, body: "lgtm" }],
    ]);

    const picked = await fetchLatestPriorRoastComment(
      octokit,
      "acme",
      "widgets",
      7,
    );

    assert.equal(picked?.id, 501);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.direction, "desc");
    assert.equal(calls[0]!.page, 1);
  });

  it("keeps walking when the newest roast sits deeper in the thread", async () => {
    // Regression: 200 chatter comments, then the roast. The old ascending scan
    // of the first 200 comments could never reach it on a long PR.
    const { octokit, calls } = stubOctokit([
      chatter(900),
      chatter(800),
      [{ id: 5, body: roastBody("older roast") }],
    ]);

    const picked = await fetchLatestPriorRoastComment(
      octokit,
      "acme",
      "widgets",
      7,
    );

    assert.equal(picked?.id, 5);
    assert.deepEqual(
      calls.map((c) => c.page),
      [1, 2, 3],
    );
  });

  it("stops at a short page instead of paginating forever", async () => {
    const { octokit, calls } = stubOctokit([[{ id: 9, body: "lgtm" }]]);

    const { picked, logged } = await withConsoleError(() =>
      fetchLatestPriorRoastComment(octokit, "acme", "widgets", 7),
    );

    assert.equal(picked, null);
    assert.equal(calls.length, 1);
    // "This PR has never been roasted" is a short page, not the give-up path.
    assert.equal(
      logged.some((line) => line.includes("gave up")),
      false,
    );
  });

  it("gives up after the page cap", async () => {
    const { octokit, calls } = stubOctokit([
      chatter(900),
      chatter(800),
      chatter(700),
    ]);

    const { picked, logged } = await withConsoleError(() =>
      fetchLatestPriorRoastComment(octokit, "acme", "widgets", 7),
    );

    assert.equal(picked, null);
    assert.equal(calls.length, MAX_PRIOR_ROAST_PAGES);
    // "We stopped looking" must not look like "there was never a roast".
    assert.match(
      logged.join("\n"),
      new RegExp(`gave up after ${MAX_PRIOR_ROAST_PAGES} pages`),
    );
  });

  it("keeps looking past an excluded roast", async () => {
    const page1 = [{ id: 42, body: roastBody("triggering") }, ...chatter(900, 99)];
    const { octokit, calls } = stubOctokit([
      page1,
      [{ id: 7, body: roastBody("prior") }],
    ]);

    const picked = await fetchLatestPriorRoastComment(
      octokit,
      "acme",
      "widgets",
      7,
      42,
    );

    assert.equal(picked?.id, 7);
    assert.equal(calls.length, 2);
  });
});
