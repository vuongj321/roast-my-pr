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

/**
 * Pick the most recent prior roast comment (oldest→newest order).
 * Returns the comment id too, so callers can read its embedded state.
 */
export function selectLatestPriorRoastComment(
  comments: IssueCommentLike[],
  excludeCommentId?: number,
): { id: number; body: string } | null {
  let latest: { id: number; body: string } | null = null;
  for (const comment of comments) {
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

  return {
    title: pr.title || "(untitled)",
    body: pr.body || "",
    author: pr.user?.login || "unknown",
    files,
    filesIncomplete,
    headSha: pr.head?.sha,
    baseSha: pr.base?.sha,
  };
}

/** GitHub caps a single comparison at 300 files. */
const MAX_COMPARE_FILES = 300;

export type ReviewDelta = {
  files: DiffFile[];
  commits: number;
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
      truncated: entries.length > MAX_COMPARE_FILES,
      unavailable: false,
    };
  } catch (err) {
    console.error("Review delta unavailable", formatGithubError(err));
    return empty;
  }
}

/**
 * Load the latest prior Roast my PR comment (footer-marked) with its id, so the
 * caller can also read the review state hidden in its footer.
 * Caps at ~100 comments to keep Worker latency bounded.
 */
export async function fetchLatestPriorRoastComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  excludeCommentId?: number,
): Promise<{ id: number; body: string } | null> {
  const comments: IssueCommentLike[] = [];
  const perPage = 100;
  const { data } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: perPage,
    page: 1,
  });
  for (const c of data) {
    comments.push({ id: c.id, body: c.body });
  }
  // One page is enough for typical PRs; if full, take one more page of newest.
  if (data.length === perPage) {
    const { data: page2 } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: perPage,
      page: 2,
    });
    for (const c of page2) {
      comments.push({ id: c.id, body: c.body });
    }
  }
  return selectLatestPriorRoastComment(comments, excludeCommentId);
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
