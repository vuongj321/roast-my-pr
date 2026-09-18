import type { Env, RoastState } from "./types.js";
import { isPullRequestComment, parseCommand } from "./command.js";
import {
  createAppOctokit,
  fetchLatestPriorRoastComment,
  fetchPullContext,
  fetchReviewDelta,
  formatGithubError,
  postComment,
  type ReviewDelta,
} from "./github.js";
import {
  ERROR_COMMENT,
  QUOTA_COMMENT,
  RATE_LIMIT_COMMENT,
  buildRoastFooter,
  parseFindingsFromRoast,
  readRoastState,
  stripRoastFooter,
} from "./prompts.js";
import { consumeRoastSlot } from "./rateLimit.js";
import { isPlanningDump, isPostableRoast } from "./responseText.js";
import { RoastQuotaError, generateRoast } from "./roast.js";

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
    const [pull, priorComment] = await Promise.all([
      fetchPullContext(octokit, owner, repo, number),
      fetchLatestPriorRoastComment(
        octokit,
        owner,
        repo,
        number,
        excludeCommentId,
      ),
    ]);

    // Review state is what lets this run answer "did you already fix that?"
    // instead of guessing from a packed diff. Older roasts have no state, so we
    // fall back to deriving findings from their bullets.
    const priorState = readRoastState(priorComment?.body);
    const priorRoast = priorComment?.body ?? null;
    // A prior comment that is a planning dump was never a review: its stored
    // findings are prompt echoes ("Author: @x") and its SHA is meaningless, so
    // neither is carried into this run.
    const priorUsable = !isPlanningDump(stripRoastFooter(priorRoast ?? ""));
    const priorFindings = priorUsable
      ? priorState?.findings.length
        ? priorState.findings
        : parseFindingsFromRoast(priorRoast ?? "")
      : [];
    const priorSha = priorUsable ? (priorState?.sha ?? null) : null;

    let delta: ReviewDelta | null = null;
    if (priorSha && pull.headSha && priorSha !== pull.headSha) {
      const fetched = await fetchReviewDelta(
        octokit,
        owner,
        repo,
        priorSha,
        pull.headSha,
      );
      if (!fetched.unavailable && fetched.files.length > 0) delta = fetched;
    }

    const roast = await generateRoast(env, {
      owner,
      repo,
      number,
      title: pull.title,
      body: pull.body,
      author: pull.author,
      files: pull.files,
      filesIncomplete: pull.filesIncomplete,
      commitMessages: pull.commitMessages,
      priorRoast,
      priorFindings,
      reviewedSha: priorSha,
      deltaFiles: delta?.files,
      deltaCommits: delta?.commits,
      deltaCommitMessages: delta?.commitMessages,
    });

    console.error(
      `Roast posted (${roast.provider}): coverage ${roast.coverage.includedFiles}/${roast.coverage.totalFiles} files (${roast.coverage.shownChars}/${roast.coverage.totalChars} patch chars); priorFindings=${priorFindings.length}; deltaFiles=${delta?.files.length ?? 0}; reviewedSha=${priorSha?.slice(0, 7) ?? "none"}`,
    );

    const state: RoastState = {
      v: 1,
      sha: pull.headSha,
      // Only a structured roast has findings worth remembering; a fallback dump
      // must not seed the next run's accounting.
      findings: isPostableRoast(roast.text)
        ? parseFindingsFromRoast(roast.text)
        : [],
    };

    await postComment(
      octokit,
      owner,
      repo,
      number,
      `${roast.text}${buildRoastFooter(roast.model, state)}`,
    );
  } catch (err) {
    console.error("Roast failed", formatGithubError(err));
    if (err instanceof RoastQuotaError) {
      await postComment(octokit, owner, repo, number, QUOTA_COMMENT);
      return;
    }
    await postComment(octokit, owner, repo, number, ERROR_COMMENT);
  }
}
