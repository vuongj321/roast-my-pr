import type { Env } from "./types.js";
import { isPullRequestComment, parseCommand } from "./command.js";
import {
  createAppOctokit,
  fetchPullDiff,
  postComment,
} from "./github.js";
import {
  ACK_COMMENT,
  ERROR_COMMENT,
  HELP_COMMENT,
  QUOTA_COMMENT,
  RATE_LIMIT_COMMENT,
} from "./prompts.js";
import { consumeRoastSlot } from "./rateLimit.js";
import { GeminiQuotaError, generateRoast } from "./roast.js";

interface IssueCommentPayload {
  action?: string;
  installation?: { id?: number };
  repository?: {
    name?: string;
    owner?: { login?: string };
  };
  issue?: {
    number?: number;
    pull_request?: unknown;
  };
  comment?: {
    id?: number;
    body?: string;
    user?: {
      login?: string;
      type?: string;
    };
  };
  sender?: {
    login?: string;
    type?: string;
  };
}

function maxDiffChars(env: Env): number {
  return Math.max(5_000, Number.parseInt(env.MAX_DIFF_CHARS || "80000", 10) || 80_000);
}

/**
 * Handle a verified issue_comment webhook.
 */
export async function handleIssueComment(
  env: Env,
  payload: IssueCommentPayload,
): Promise<void> {
  if (payload.action !== "created") return;

  const senderType = payload.sender?.type || payload.comment?.user?.type;
  if (senderType === "Bot") return;

  if (!isPullRequestComment(payload)) return;

  const body = payload.comment?.body || "";
  const command = parseCommand(body);
  if (!command) return;

  const installationId = payload.installation?.id;
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const number = payload.issue?.number;

  if (!installationId || !owner || !repo || !number) {
    console.error("Missing installation or repository fields on webhook payload");
    return;
  }

  const octokit = createAppOctokit(env, installationId);

  if (command.kind === "help") {
    await postComment(octokit, owner, repo, number, HELP_COMMENT);
    return;
  }

  const slot = await consumeRoastSlot(env, installationId);
  if (!slot.allowed) {
    await postComment(octokit, owner, repo, number, RATE_LIMIT_COMMENT);
    return;
  }

  await postComment(octokit, owner, repo, number, ACK_COMMENT);

  try {
    const pull = await fetchPullDiff(
      octokit,
      owner,
      repo,
      number,
      maxDiffChars(env),
    );

    const roast = await generateRoast(env, {
      owner,
      repo,
      number,
      title: pull.title,
      body: pull.body,
      author: pull.author,
      diff: pull.diff,
      truncated: pull.truncated,
    });

    const footer =
      "\n\n---\n*Roasted by **Roast my PR** · self-hosted free-tier bot*";
    await postComment(octokit, owner, repo, number, `${roast}${footer}`);
  } catch (err) {
    console.error("Roast failed", err);
    if (err instanceof GeminiQuotaError) {
      await postComment(octokit, owner, repo, number, QUOTA_COMMENT);
      return;
    }
    await postComment(octokit, owner, repo, number, ERROR_COMMENT);
  }
}
