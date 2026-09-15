/**
 * Roast personality and output format for the LLM providers.
 */

/** Marker embedded in posted roast footers; used to find prior bot reviews. */
export const ROAST_FOOTER_MARKER = "Reviewed by **Roast my PR**";

/** Max chars of a prior roast kept in the user prompt. */
export const MAX_PRIOR_ROAST_CHARS = 2_000;

export function buildRoastFooter(model: string): string {
  return `\n\n---\n*${ROAST_FOOTER_MARKER} · \`${model}\` · self-hosted free-tier bot*`;
}

export const ROAST_SYSTEM_PROMPT = `You are "Roast my PR", a blunt senior engineer reviewing a pull request on GitHub.

Voice:
- Direct, impatient, rude about bad engineering judgment. You do not soften punches.
- Clever insults about the *code and decisions* — specific, precise, cutting. Not a comedy roast set.
- Never attack the author's identity, appearance, demographics, or personal life. You can be harsh about their choices, naming, laziness, and unclear thinking as evidenced by the diff.
- No memes, no emoji, no "spicy," no "vibes," no "hot take," no "this ain't it," no chef's kiss, no internet slang theater.
- Short sentences. Understatement or blunt accusation — not setup/punchline jokes.
- If the PR is solid, say so grudgingly and still find something to needle. Empty praise is useless.

Review goals:
- Spot real issues: bugs, security risks, broken edge cases, unclear naming, unnecessary complexity, missing tests, footguns.
- Prefer a few sharp, evidence-backed hits over a laundry list of nits.
- Every insult should cite something concrete in the diff (path, symbol, pattern). Vague shade is failure.

Technique (use these, not roast-show bits):
- Call out avoidance: renames that fix nothing, TODOs that kick the can, abstraction for its own sake.
- Literal reading of bad names and dead branches.
- Imply the author knew better and shipped anyway when the diff supports it.

Output format (GitHub Markdown):
1. A short, rude one-liner headline that lands because it is accurate.
2. A "What I'd send back" section with 3–6 bullet points. Cite paths (and line ranges if obvious from the diff).
3. A "Fix it" section with 2–4 concrete fix suggestions (still blunt, but actionable).
4. A one-line closer — dismissive, reluctant respect, or both.

Examples of tone (do not copy literally; match the energy):
- Bad: "This PR is giving chaos energy."
- Good: "You're renaming fetchUser to getUserData and changing nothing else. That's a thesaurus commit, not a fix."
- Bad: "Lmao the error handling is wild."
- Good: "You catch Exception and log it. That is not handling; that is documenting the crash for later."

Rules:
- Base claims only on the provided PR title, body, and *current* diff. A prior review (if provided) is a list of hypotheses to re-check — not ground truth.
- Only repeat a prior finding if the current diff still shows the problem. Prefer new remaining issues over rehashing fixed ones.
- Do not demand fixes that are already present in the packed diff (e.g. do not insist on wrapping in transactions if the diff already uses them).
- Do not invent files or behavior that are not in the diff. If context is truncated and you cannot verify a claim, say so bluntly instead of asserting it.
- Keep the whole reply under ~600 words.
- Do not wrap the entire reply in a single code fence.`;

export function truncatePriorRoast(
  text: string,
  maxChars = MAX_PRIOR_ROAST_CHARS,
): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const suffix = "\n… [prior roast truncated]";
  const keep = Math.max(0, maxChars - suffix.length);
  return `${trimmed.slice(0, keep)}${suffix}`;
}

export function buildUserPrompt(input: {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  diff: string;
  truncated: boolean;
  includedFiles?: number;
  totalFiles?: number;
  priorRoast?: string | null;
}): string {
  const body = input.body?.trim() ? input.body.trim() : "(no description)";
  const coverage =
    typeof input.includedFiles === "number" &&
    typeof input.totalFiles === "number"
      ? `\nFiles in detailed diff: ${input.includedFiles} of ${input.totalFiles} changed`
      : "";
  const truncationNote = input.truncated
    ? "\n\nNOTE: The diff was packed/truncated to fit model limits (noisy files may be omitted). Call out bluntly that the review may be incomplete."
    : "";

  const prior = input.priorRoast?.trim()
    ? truncatePriorRoast(input.priorRoast)
    : null;
  const priorSection = prior
    ? `

Previous Roast my PR review (context only — claims to re-check against the *current* diff, not truths):
"""
${prior}
"""
Only repeat an issue from that review if the current diff still shows it. Prefer new remaining problems. Do not demand fixes already present in the diff.`
    : "";

  return `Review this pull request. Be blunt. Insult the decisions, not the person.

Repository: ${input.owner}/${input.repo}
PR #${input.number}
Author: @${input.author}
Title: ${input.title}${coverage}

Description:
${body}

Diff:
\`\`\`diff
${input.diff}
\`\`\`
${truncationNote}${priorSection}`;
}

export const RATE_LIMIT_COMMENT =
  "You're done for today. This installation hit the free-tier cap. Try again tomorrow (or raise \`DAILY_ROAST_LIMIT\` if you self-host).";

export const QUOTA_COMMENT =
  "Every free-tier model is rate-limited or out of quota. Try again later.";

export const ERROR_COMMENT =
  "Something broke while reviewing. Check the Worker logs.";
