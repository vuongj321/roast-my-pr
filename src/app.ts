import type { Env } from "./types.js";
import { isPullRequestComment, parseCommand } from "./command.js";
import {
  createAppOctokit,
  fetchLatestPriorRoast,
  fetchPullContext,
  formatGithubError,
  postComment,
} from "./github.js";
import {
  ERROR_COMMENT,
  QUOTA_COMMENT,
  RATE_LIMIT_COMMENT,
  UNVERIFIED_COMMENT,
  buildRoastFooter,
} from "./prompts.js";
import { consumeRoastSlot } from "./rateLimit.js";
import {
  RoastQuotaError,
  RoastUnverifiedError,
  generateRoast,
} from "./roast.js";

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

  const slot = await consumeRoastSlot(env, installationId);
  if (!slot.allowed) {
    await postComment(octokit, owner, repo, number, RATE_LIMIT_COMMENT);
    return;
  }

  try {
    const excludeCommentId = payload.comment?.id;
    const [pull, priorRoast] = await Promise.all([
      fetchPullContext(octokit, owner, repo, number),
      fetchLatestPriorRoast(
        octokit,
        owner,
        repo,
        number,
        excludeCommentId,
      ),
    ]);

    const roast = await generateRoast(env, {
      owner,
      repo,
      number,
      title: pull.title,
      body: pull.body,
      author: pull.author,
      files: pull.files,
      filesIncomplete: pull.filesIncomplete,
      priorRoast,
    });

    await postComment(
      octokit,
      owner,
      repo,
      number,
      `${roast.text}${buildRoastFooter(roast.model)}`,
    );
  } catch (err) {
    console.error("Roast failed", formatGithubError(err));
    if (err instanceof RoastQuotaError) {
      await postComment(octokit, owner, repo, number, QUOTA_COMMENT);
      return;
    }
    if (err instanceof RoastUnverifiedError) {
      await postComment(octokit, owner, repo, number, UNVERIFIED_COMMENT);
      return;
    }
    await postComment(octokit, owner, repo, number, ERROR_COMMENT);
  }
}
