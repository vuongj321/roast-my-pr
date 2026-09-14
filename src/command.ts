import type { RoastCommand } from "./types.js";

const COMMAND_RE =
  /^\s*\/(?:roastmypr|roast(?:\s+my\s+pr)?)\b(?:\s+(help))?\s*$/i;

/**
 * Parse the first line of a comment for /roastmypr commands.
 */
export function parseCommand(commentBody: string): RoastCommand | null {
  const firstLine = (commentBody || "").split(/\r?\n/, 1)[0] ?? "";
  const match = firstLine.match(COMMAND_RE);
  if (!match) return null;

  if (match[1]?.toLowerCase() === "help") {
    return { kind: "help", raw: firstLine.trim() };
  }

  return { kind: "roast", raw: firstLine.trim() };
}

export function isPullRequestComment(payload: {
  issue?: { pull_request?: unknown };
}): boolean {
  return Boolean(payload.issue?.pull_request);
}
