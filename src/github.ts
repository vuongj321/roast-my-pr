import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { Env } from "./types.js";

function normalizePrivateKey(pem: string): string {
  // Support secrets stored with literal \n sequences.
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
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

export interface PullDiff {
  title: string;
  body: string;
  author: string;
  diff: string;
  truncated: boolean;
}

/**
 * Load PR metadata + unified patches, truncated to MAX_DIFF_CHARS.
 */
export async function fetchPullDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  maxDiffChars: number,
): Promise<PullDiff> {
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });

  const files: Array<{ filename: string; status: string; patch?: string | null }> = [];
  const perPage = 100;
  let page = 1;

  for (;;) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: perPage,
      page,
    });
    files.push(...data);
    if (data.length < perPage) break;
    page += 1;
    // Safety: huge PRs — stop paginating after ~300 files; truncation note covers the rest.
    if (page > 3) break;
  }

  const chunks: string[] = [];
  let used = 0;
  let truncated = page > 3;

  for (const file of files) {
    const header = `--- ${file.filename} (${file.status})\n`;
    const patch = file.patch ? `${file.patch}\n` : "(binary or too large to include patch)\n";
    const block = header + patch;

    if (used + block.length > maxDiffChars) {
      const remaining = maxDiffChars - used;
      if (remaining > 200) {
        chunks.push(block.slice(0, remaining) + "\n… [truncated]\n");
      }
      truncated = true;
      break;
    }

    chunks.push(block);
    used += block.length;
  }

  if (files.length === 0) {
    chunks.push("(no file patches available)");
  }

  return {
    title: pr.title || "(untitled)",
    body: pr.body || "",
    author: pr.user?.login || "unknown",
    diff: chunks.join("\n"),
    truncated,
  };
}
