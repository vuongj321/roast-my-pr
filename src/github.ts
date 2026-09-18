import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { DiffFile } from "./diffPack.js";
import { ROAST_FOOTER_MARKER } from "./prompts.js";
import type { Env } from "./types.js";

export type IssueCommentLike = {
  id: number;
  body?: string | null;
};

export function isRoastBotComment(body: string | null | undefined): boolean {
  return Boolean(body && body.includes(ROAST_FOOTER_MARKER));
}

/** Order in which the API returned the comments we are scanning. */
export type CommentOrder = "asc" | "desc";

/**
 * Pick the most recent prior roast comment. Returns the comment id too, so
 * callers can read its embedded state.
 *
 * `order` must describe the page it is handed: `asc` (oldest→newest, the REST
 * default) means "keep the last match"; `desc` (newest→oldest) means "keep the
 * first". Passing the wrong order silently selects a stale roast, which is how
 * review memory went stale on PRs with a long comment history.
 */
export function selectLatestPriorRoastComment(
  comments: IssueCommentLike[],
  excludeCommentId?: number,
  order: CommentOrder = "asc",
): { id: number; body: string } | null {
  // Normalize to ascending so there is a single selection rule below.
  const scan = order === "asc" ? comments : [...comments].reverse();
  let latest: { id: number; body: string } | null = null;
  for (const comment of scan) {
    if (
      excludeCommentId !== undefined &&
      comment.id === excludeCommentId
    ) {
      continue;
    }
    if (!isRoastBotComment(comment.body)) continue;
    latest = { id: comment.id, body: (comment.body || "").trim() };
  }
  return latest;
}

/** @deprecated Use selectLatestPriorRoastComment */
export function selectLatestPriorRoast(
  comments: IssueCommentLike[],
  excludeCommentId?: number,
): string | null {
  return selectLatestPriorRoastComment(comments, excludeCommentId)?.body ?? null;
}

function normalizePrivateKey(pem: string): string {
  // Support secrets stored with literal \n sequences.
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

/**
 * Pull status + GitHub JSON body out of Octokit/fetch errors for Worker logs.
 */
export function formatGithubError(err: unknown): string {
  if (!err || typeof err !== "object") {
    return String(err);
  }

  const e = err as {
    message?: string;
    status?: number;
    response?: {
      url?: string;
      data?: unknown;
      headers?: Record<string, string>;
    };
  };

  const parts: string[] = [];
  if (typeof e.status === "number") parts.push(`status=${e.status}`);
  if (e.response?.url) parts.push(`url=${e.response.url}`);
  if (e.message) parts.push(e.message);

  const data = e.response?.data;
  if (data !== undefined) {
    try {
      parts.push(`body=${typeof data === "string" ? data : JSON.stringify(data)}`);
    } catch {
      parts.push("body=[unserializable]");
    }
  }

  return parts.length > 0 ? parts.join(" | ") : String(err);
}

export function createAppOctokit(env: Env, installationId: number): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.APP_ID,
      privateKey: normalizePrivateKey(env.PRIVATE_KEY),
      installationId,
    },
  });
}

export async function postComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
}

export interface PullContext {
  title: string;
  body: string;
  author: string;
  files: DiffFile[];
  /** True when pagination stopped early (~300 files). */
  filesIncomplete: boolean;
  /** Head commit SHA at fetch time — the anchor written into review state. */
  headSha?: string;
  /** Base commit SHA of the PR. */
  baseSha?: string;
  /** First-line subjects from PR commits (stated intent / tradeoffs). */
  commitMessages: string[];
}

/** Cap how many commit subjects enter the roast prompt. */
export const MAX_COMMIT_MESSAGES = 12;

/** Cap length of each commit subject line. */
export const MAX_COMMIT_SUBJECT_CHARS = 160;

/** First line of a commit message, clipped for the prompt. */
export function truncateCommitSubject(
  message: string,
  maxChars = MAX_COMMIT_SUBJECT_CHARS,
): string {
  const firstLine = (message || "").split(/\r?\n/)[0]?.trim() || "";
  if (!firstLine) return "";
  if (firstLine.length <= maxChars) return firstLine;
  return `${firstLine.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Normalize raw commit messages into capped subject lines. */
export function commitSubjectsFromMessages(
  messages: readonly (string | null | undefined)[],
  maxMessages = MAX_COMMIT_MESSAGES,
): string[] {
  const out: string[] = [];
  for (const raw of messages) {
    if (out.length >= maxMessages) break;
    const subject = truncateCommitSubject(raw || "");
    if (subject) out.push(subject);
  }
  return out;
}

/**
 * Load PR metadata + changed file patches (unbounded list; packing happens per provider).
 */
export async function fetchPullContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PullContext> {
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });

  const files: DiffFile[] = [];
  const perPage = 100;
  let page = 1;
  let filesIncomplete = false;

  for (;;) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: perPage,
      page,
    });
    for (const f of data) {
      files.push({
        filename: f.filename,
        status: f.status,
        patch: f.patch,
      });
    }
    if (data.length < perPage) break;
    page += 1;
    // Safety: huge PRs — stop paginating after ~300 files.
    if (page > 3) {
      filesIncomplete = true;
      break;
    }
  }

  const commitMessages = await fetchPullCommitSubjects(
    octokit,
    owner,
    repo,
    pullNumber,
  );

  return {
    title: pr.title || "(untitled)",
    body: pr.body || "",
    author: pr.user?.login || "unknown",
    files,
    filesIncomplete,
    headSha: pr.head?.sha,
    baseSha: pr.base?.sha,
    commitMessages,
  };
}

/** First-line subjects from `pulls.listCommits` (capped). */
export async function fetchPullCommitSubjects(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<string[]> {
  try {
    const { data } = await octokit.rest.pulls.listCommits({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: MAX_COMMIT_MESSAGES,
    });
    return commitSubjectsFromMessages(
      data.map((c) => c.commit?.message),
    );
  } catch (err) {
    console.error("PR commit list unavailable", formatGithubError(err));
    return [];
  }
}

/** GitHub caps a single comparison at 300 files. */
const MAX_COMPARE_FILES = 300;

export type ReviewDelta = {
  files: DiffFile[];
  commits: number;
  /** First-line subjects for commits in the compare range. */
  commitMessages: string[];
  /** True when the comparison hit GitHub's 300-file cap. */
  truncated: boolean;
  /** True when a SHA is gone (force-push) or the comparison failed. */
  unavailable: boolean;
};

/**
 * What changed between the commit we last reviewed and the current head.
 *
 * This is the signal that stops the bot re-reporting items the author already
 * fixed: it is the only input that distinguishes "still broken" from "you could
 * not see it in the packed diff".
 */
export async function fetchReviewDelta(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
): Promise<ReviewDelta> {
  const empty: ReviewDelta = {
    files: [],
    commits: 0,
    commitMessages: [],
    truncated: false,
    unavailable: true,
  };
  if (!baseSha || !headSha || baseSha === headSha) return empty;

  try {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${baseSha}...${headSha}`,
    });
    const entries = data.files ?? [];
    const files: DiffFile[] = entries.slice(0, MAX_COMPARE_FILES).map((f) => ({
      filename: f.filename,
      status: f.status,
      patch: f.patch,
    }));
    return {
      files,
      commits: data.commits?.length ?? 0,
      commitMessages: commitSubjectsFromMessages(
        (data.commits ?? []).map((c) => c.commit?.message),
      ),
      truncated: entries.length > MAX_COMPARE_FILES,
      unavailable: false,
    };
  } catch (err) {
    console.error("Review delta unavailable", formatGithubError(err));
    return empty;
  }
}

/** Comments requested per page while hunting for the newest prior roast. */
export const PRIOR_ROAST_PAGE_SIZE = 100;

/**
 * How many pages of newest-first comments we will walk before giving up. A PR
 * whose newest roast is buried deeper than this is treated as having no prior
 * review rather than stalling the Worker.
 */
export const MAX_PRIOR_ROAST_PAGES = 3;

/**
 * Load the newest prior Roast my PR comment (footer-marked) with its id, so the
 * caller can also read the review state hidden in its footer.
 *
 * Walked newest-first (`direction: "desc"`) and stopped at the first roast. The
 * previous version read pages 1-2 of the REST default ordering (oldest→newest)
 * and kept the last match, so on a PR with more than 200 comments it never saw
 * the newest roast: review memory stayed pinned to an old SHA and the delta
 * spanned everything since that older review.
 */
export async function fetchLatestPriorRoastComment(
  octokit: Pick<Octokit, "rest">,
  owner: string,
  repo: string,
  issueNumber: number,
  excludeCommentId?: number,
): Promise<{ id: number; body: string } | null> {
  for (let page = 1; page <= MAX_PRIOR_ROAST_PAGES; page += 1) {
    const { data } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: PRIOR_ROAST_PAGE_SIZE,
      page,
      sort: "created",
      direction: "desc",
    });

    const picked = selectLatestPriorRoastComment(
      data.map((c) => ({ id: c.id, body: c.body })),
      excludeCommentId,
      "desc",
    );
    if (picked) return picked;

    // A short page means there is nothing older left to read.
    if (data.length < PRIOR_ROAST_PAGE_SIZE) return null;
  }
  return null;
}

/** @deprecated Use fetchLatestPriorRoastComment */
export async function fetchLatestPriorRoast(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  excludeCommentId?: number,
): Promise<string | null> {
  const comment = await fetchLatestPriorRoastComment(
    octokit,
    owner,
    repo,
    issueNumber,
    excludeCommentId,
  );
  return comment?.body ?? null;
}

/** @deprecated Use fetchPullContext */
export const fetchPullDiff = fetchPullContext;
