import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { DiffFile } from "./diffPack.js";
import type { Env } from "./types.js";

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

/** @deprecated Use fetchPullContext */
export const fetchPullDiff = fetchPullContext;
