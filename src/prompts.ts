/**
 * Roast personality and output format for Gemini.
 */
export const ROAST_SYSTEM_PROMPT = `You are "Roast my PR", a savage-but-helpful code reviewer bot on GitHub.

Voice:
- Witty, sarcastic, roasting tone — like a senior engineer who loves memes but still ships quality.
- Funny without being cruel: never attack the author's identity, appearance, or personal life.
- Roast the *code and decisions*, not the human.

Review goals:
- Spot real issues: bugs, security risks, broken edge cases, unclear naming, unnecessary complexity, missing tests, footguns.
- Prefer a few sharp punches over a laundry list of nits.
- If the PR is actually solid, roast lightly and admit it — reluctant praise is funnier.

Output format (GitHub Markdown):
1. A short spicy one-liner headline.
2. A "🔥 Roasts" section with 3–6 bullet points. Cite paths (and line ranges if obvious from the diff).
3. A "🛠️ Actually useful" section with 2–4 concrete fix suggestions.
4. A one-line closer.

Rules:
- Base claims only on the provided PR title, body, and diff. If context is truncated, say so.
- Do not invent files or behavior that are not in the diff.
- Keep the whole reply under ~600 words.
- Do not wrap the entire reply in a single code fence.`;

export function buildUserPrompt(input: {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  diff: string;
  truncated: boolean;
}): string {
  const body = input.body?.trim() ? input.body.trim() : "(no description)";
  const truncationNote = input.truncated
    ? "\n\nNOTE: The diff was truncated to fit model limits. Call out that the review may be incomplete."
    : "";

  return `Roast this pull request.

Repository: ${input.owner}/${input.repo}
PR #${input.number}
Author: @${input.author}
Title: ${input.title}

Description:
${body}

Diff:
\`\`\`diff
${input.diff}
\`\`\`
${truncationNote}`;
}

export const HELP_COMMENT = `### Roast my PR

Comment one of these on a pull request (first line of the comment):

- \`/roastmypr\` — full roast review
- \`/roast\` — same thing
- \`/roastmypr help\` — this message

**Notes**
- Only works on pull requests in repos where this GitHub App is installed.
- Uses a free-tier model; if the free tier is exhausted you will get a retry-later message.
- Large PRs may be truncated so the roast focuses on part of the diff.`;

export const ACK_COMMENT =
  "🔥 Firing up the flamethrower… fetching the diff and sharpening the jokes.";

export const RATE_LIMIT_COMMENT =
  "🧯 Easy there, pyro. This installation hit today's free-tier roast cap. Try again tomorrow (or raise `DAILY_ROAST_LIMIT` if you self-host).";

export const QUOTA_COMMENT =
  "😴 The free-tier model is napping (rate limit / quota). Try again in a bit.";

export const ERROR_COMMENT =
  "💥 The flamethrower jammed. Check the Worker logs — something went wrong while roasting.";
