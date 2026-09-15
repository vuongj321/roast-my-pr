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
 * Pick the most recent prior roast body from issue comments (oldest→newest order).
 */
export function selectLatestPriorRoast(
  comments: IssueCommentLike[],
  excludeCommentId?: number,
): string | null {
  let latest: string | null = null;
  for (const comment of comments) {
    if (
      excludeCommentId !== undefined &&
      comment.id === excludeCommentId
    ) {
      continue;
    }
    if (!isRoastBotComment(comment.body)) continue;
    latest = (comment.body || "").trim();
  }
  return latest || null;
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
  };
}

/**
 * Load the latest prior Roast my PR comment on this issue/PR (footer-marked).
 * Caps at ~100 comments to keep Worker latency bounded.
 */
export async function fetchLatestPriorRoast(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  excludeCommentId?: number,
): Promise<string | null> {
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
  return selectLatestPriorRoast(comments, excludeCommentId);
}

/** @deprecated Use fetchPullContext */
export const fetchPullDiff = fetchPullContext;
