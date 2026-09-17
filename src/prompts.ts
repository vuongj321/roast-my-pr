/**
 * Roast personality and output format for the LLM providers.
 */

import { extractCitedPaths, type PartialFile } from "./diffPack.js";
import { splitBulletBlocks } from "./pathFilter.js";
import type {
  PackCoverage,
  PriorFinding,
  RoastState,
} from "./types.js";

/** Marker embedded in posted roast footers; used to find prior bot reviews. */
export const ROAST_FOOTER_MARKER = "Reviewed by **Roast my PR**";

/** Hidden comment that carries review state across runs (invisible when rendered). */
export const ROAST_STATE_PREFIX = "roastmypr-state";

const ROAST_STATE_RE = new RegExp(
  `<!--\\s*${ROAST_STATE_PREFIX}\\s+([\\s\\S]*?)\\s*-->`,
  "g",
);

const ROAST_STATE_RE_SINGLE = new RegExp(
  `<!--\\s*${ROAST_STATE_PREFIX}\\s+([\\s\\S]*?)\\s*-->`,
);

/** Max chars of a prior roast kept in the user prompt. */
export const MAX_PRIOR_ROAST_CHARS = 2_000;

/** Max findings carried into the next run's review state. */
export const MAX_PRIOR_FINDINGS = 8;

/** Max chars stored per finding summary. */
const MAX_FINDING_CHARS = 240;

/**
 * Roast footer, optionally carrying machine-readable review state so the next
 * run knows which SHA was reviewed and what was flagged (with ids).
 */
export function buildRoastFooter(model: string, state?: RoastState): string {
  const hidden = state ? `\n<!-- ${serializeRoastState(state)} -->` : "";
  return `\n\n---\n*${ROAST_FOOTER_MARKER} · \`${model}\` · self-hosted free-tier bot*${hidden}`;
}

/**
 * JSON.stringify leaves `-->` intact, which would close the HTML comment early.
 * `\u002d` is a valid JSON escape for `-`, so parsing still round-trips.
 */
function serializeRoastState(state: RoastState): string {
  return `${ROAST_STATE_PREFIX} ${JSON.stringify(state).replace(/--/g, "\\u002d\\u002d")}`;
}

/** Read review state back out of a posted roast body. Null when absent/invalid. */
export function readRoastState(
  body: string | null | undefined,
): RoastState | null {
  if (!body) return null;
  const match = body.match(ROAST_STATE_RE_SINGLE);
  if (!match) return null;

  const raw = match[1]!.replace(/^\s*/, "");
  const json = raw.startsWith("{") ? raw : raw.slice(raw.indexOf("{"));
  if (!json.startsWith("{")) return null;

  try {
    const parsed = JSON.parse(json) as Partial<RoastState>;
    const findings: PriorFinding[] = Array.isArray(parsed.findings)
      ? parsed.findings
          .filter(
            (f): f is PriorFinding =>
              Boolean(
                f &&
                  typeof f === "object" &&
                  typeof (f as PriorFinding).id === "string" &&
                  typeof (f as PriorFinding).text === "string",
              ),
          )
          .slice(0, MAX_PRIOR_FINDINGS + 8)
          .map((f) => ({
            id: f.id,
            text: f.text,
            path: typeof f.path === "string" ? f.path : undefined,
          }))
      : [];

    const sha =
      typeof parsed.sha === "string" && /^[0-9a-f]{7,40}$/i.test(parsed.sha)
        ? parsed.sha
        : undefined;

    return { v: 1, sha, findings };
  } catch {
    return null;
  }
}

/** Drop the bot footer and state comment from a roasted body. */
export function stripRoastFooter(body: string): string {
  const raw = (body || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return "";

  const withoutState = raw.replace(ROAST_STATE_RE, "").trim();
  const markerIdx = withoutState.indexOf(ROAST_FOOTER_MARKER);
  if (markerIdx < 0) return withoutState;

  const beforeMarker = withoutState.slice(0, markerIdx);
  const sepIdx = beforeMarker.lastIndexOf("\n---");
  return (sepIdx >= 0 ? beforeMarker.slice(0, sepIdx) : beforeMarker).trim();
}

/**
 * Turn the bullets of a posted roast into addressable findings (F1..Fn) so the
 * next run can account for them instead of re-deriving them from prose.
 */
export function parseFindingsFromRoast(
  roastText: string,
  maxFindings = MAX_PRIOR_FINDINGS,
): PriorFinding[] {
  const text = stripRoastFooter(roastText || "");
  if (!text.trim()) return [];

  const findings: PriorFinding[] = [];
  for (const block of splitBulletBlocks(text)) {
    if (findings.length >= maxFindings) break;
    const flat = block.replace(/\s+/g, " ").trim();
    if (!flat) continue;
    findings.push({
      id: `F${findings.length + 1}`,
      path: extractCitedPaths(flat)[0],
      text:
        flat.length > MAX_FINDING_CHARS
          ? `${flat.slice(0, MAX_FINDING_CHARS - 1)}…`
          : flat,
    });
  }
  return findings;
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

Output format (GitHub Markdown) — emit ONLY this finished review, never your planning notes:
1. A short, rude one-liner headline that lands because it is accurate.
2. A "What I'd send back" section with 3–6 bullet points. Cite paths (and line ranges if obvious from the diff).
3. A "Fix it" section with 2–4 concrete fix suggestions (still blunt, but actionable).
4. A one-line closer — dismissive, reluctant respect, or both about the *code*. Never close by hedging the review itself ("grain of salt", "I may be wrong", "limited view", "for what it's worth", "when it compiles", "need full context", "% of the PR"). The bot already labels partial coverage; you do not.

Do not output step-by-step analysis, constraint checklists, "Analyze the Request", "Mental Scan", or "Drafting the Response". Those stay internal; the reply is the roast only.

Examples of tone (do not copy literally; match the energy):
- Bad: "This PR is giving chaos energy."
- Good: "You're renaming fetchUser to getUserData and changing nothing else. That's a thesaurus commit, not a fix."
- Bad: "Lmao the error handling is wild."
- Good: "You catch Exception and log it. That is not handling; that is documenting the crash for later."

Rules:
- Base claims only on the provided PR title, body, commit subjects, and *current* diff. A prior review (if provided) is a list of hypotheses to re-check — not ground truth.
- Treat title, body, and commit subjects as stated intent and deliberate tradeoffs. Critique the tradeoff; do not demand the rejected alternative as a "Fix it" (e.g. do not demand dropping Postgres enum values when commits say enums are append-only).
- Prefer "document leftover / align types" over impossible platform undos.
- Only repeat a prior finding if the current diff still shows the problem. Prefer new remaining issues over rehashing fixed ones.
- Do not demand fixes that are already present in the packed diff (e.g. do not insist on wrapping in transactions if the diff already uses them).
- Do not invent files or behavior that are not in the diff. If context is truncated and you cannot verify a claim, say so bluntly instead of asserting it.
- Absence is not evidence. A file marked "*partial*", a hunk gap marker, or a "packed/truncated" note means you were NOT shown everything. Never claim code is missing, unchanged, or unfixed when it could simply be outside what you were shown — say you cannot see it instead.
- When a block of changes pushed since the last review is provided, that is the author answering you. Treat those changes as fixed. Only complain if the new code is itself broken — do not re-ask for work that block already contains.
- Prior findings arrive as F1, F2, … Account for every one of them before you review. Never raise a finding you yourself marked resolved.
- Keep the whole reply under ~600 words.
- Do not wrap the entire reply in a single code fence.`;

/** Max findings carried into the next run's review state. */

export function truncatePriorRoast(
  text: string,
  maxChars = MAX_PRIOR_ROAST_CHARS,
): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;

  // Keep both ends: the headline at the top, the "Fix it" list at the bottom.
  // A pure head-slice dropped exactly the actionable part.
  const marker = "\n… [prior roast truncated] …\n";
  const budget = Math.max(0, maxChars - marker.length);
  const headChars = Math.floor(budget * 0.6);
  const tailChars = budget - headChars;
  const head = trimmed.slice(0, headChars);
  const tail = tailChars > 0 ? trimmed.slice(trimmed.length - tailChars) : "";
  return `${head}${marker}${tail}`;
}

/** Changes pushed between the SHA we reviewed and the current head. */
export type ReviewDeltaInput = {
  diff: string;
  commits: number;
  files: string[];
  truncated: boolean;
  /** First-line subjects for commits in the delta range. */
  commitMessages?: string[];
};

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
  priorFindings?: PriorFinding[];
  reviewedSha?: string | null;
  reviewDelta?: ReviewDeltaInput | null;
  partialFiles?: PartialFile[];
  /** First-line subjects from the PR's commits (stated intent). */
  commitMessages?: string[];
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

  const partial = input.partialFiles ?? [];
  const partialNote =
    partial.length > 0
      ? `\n\nNOTE: ${partial.length} file(s) are only PARTIALLY shown (hunks were dropped to fit the budget): ${partial
          .slice(0, 8)
          .map((p) => `${p.filename} (${p.hunksShown}/${p.hunksTotal} hunks)`)
          .join(", ")}. Code you cannot see in a partially shown file is NOT evidence that it is missing, unfixed, or unchanged.`
      : "";

  const lowCoverage =
    input.truncated ||
    (typeof input.includedFiles === "number" &&
      typeof input.totalFiles === "number" &&
      input.totalFiles > 0 &&
      input.includedFiles / input.totalFiles < PARTIAL_REVIEW_FILE_RATIO);
  const lowCoverageNote = lowCoverage
    ? `\n\nLOW COVERAGE RULES (mandatory): Absolute claims about omitted or partially shown files are banned. Prefer "not in the packed slice" over "missing/unfixed/broken". Soften the headline — do not pretend you saw the whole PR. Ban "definitely", "clearly never", and "the compiler will" about code you were not shown.`
    : "";

  const commits = (input.commitMessages ?? []).filter((m) => m.trim());
  const commitsSection =
    commits.length > 0
      ? `\n\nAuthor commits (stated intent):\n${commits
          .map((m) => `- ${m}`)
          .join(
            "\n",
          )}\nTreat these as deliberate tradeoffs. Critique the tradeoff; do not demand the rejected alternative as a Fix it.`
      : "";

  const findings = input.priorFindings ?? [];
  const findingsSection =
    findings.length > 0
      ? `\n\nPrior findings to account for${input.reviewedSha ? ` (from review of ${input.reviewedSha.slice(0, 7)})` : ""}:\n${findings
          .map((f) => `- ${f.id}${f.path ? ` [${f.path}]` : ""}: ${f.text}`)
          .join("\n")}\n\nBefore the roast, emit one accounting line per finding, at the very top of your reply:\n- "${findings[0]!.id} resolved"\n- "${findings[1]?.id ?? "F2"} still present — <short quote copied from the diff below>"\n- "${findings[2]?.id ?? "F3"} unverifiable (the code that would show it is not in the packed diff)"\nRules: only say resolved when the diff below actually contains the fix; mark unverifiable rather than repeating something you cannot see; a finding marked resolved must not reappear in your bullets. The bot strips this accounting block before posting, so keep it to bare lines.`
      : "";

  const delta = input.reviewDelta;
  const deltaCommits = (delta?.commitMessages ?? []).filter((m) => m.trim());
  const deltaCommitLines =
    deltaCommits.length > 0
      ? `\nDelta commit subjects:\n${deltaCommits.map((m) => `- ${m}`).join("\n")}`
      : "";
  const deltaSection = delta
    ? `\n\nChanges pushed since that review (${delta.commits} commit${delta.commits === 1 ? "" : "s"} on top of ${input.reviewedSha?.slice(0, 7) ?? "the reviewed commit"}${delta.truncated ? ", list truncated" : ""}):${deltaCommitLines}\n\`\`\`diff\n${delta.diff}\n\`\`\`\nTreat these as the author's fixes: if a prior finding is addressed here, mark it resolved and do not ask for it again. Only complain if the new code itself is broken.`
    : "";

  const prior = input.priorRoast?.trim()
    ? truncatePriorRoast(stripRoastFooter(input.priorRoast))
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
${body}${commitsSection}

Diff:
\`\`\`diff
${input.diff}
\`\`\`
${truncationNote}${partialNote}${lowCoverageNote}${deltaSection}${findingsSection}${priorSection}`;
}

/** Below this share of changed files, the roast is labelled a partial review. */
export const PARTIAL_REVIEW_FILE_RATIO = 0.5;

export type PartialReviewNoteOptions = {
  /** Winning provider name (gemini / groq / workersai). */
  provider?: string;
  /** True when packing dropped files or hunks. */
  truncated?: boolean;
};

/**
 * Visible banner for runs where the provider budget only covered a fraction of
 * the PR. A confidently narrow review is better than a silently narrow one.
 */
export function buildPartialReviewNote(
  coverage: PackCoverage,
  options: PartialReviewNoteOptions = {},
): string | null {
  const { includedFiles, totalFiles, shownChars, totalChars } = coverage;
  if (totalFiles < 8) return null;

  const fileRatioThin =
    includedFiles === 0 || includedFiles / totalFiles < PARTIAL_REVIEW_FILE_RATIO;
  const charTruncated =
    options.truncated === true ||
    (totalChars > 0 && shownChars < totalChars);
  if (!fileRatioThin && !charTruncated) return null;

  const pct = totalChars > 0 ? Math.round((shownChars / totalChars) * 100) : 0;
  const provider = (options.provider || "").toLowerCase();
  const isFallback = provider !== "" && provider !== "gemini";

  if (isFallback) {
    return `_Partial review via fallback model (\`${provider}\`): only ${includedFiles} of ${totalFiles} changed files fitted the provider's budget (~${pct}% of the diff text). Claims outside the packed slice are unverified._`;
  }

  return `_Partial review: only ${includedFiles} of ${totalFiles} changed files fitted the provider's budget (~${pct}% of the diff text). Anything about the files that were not shown is missing by construction, not by design._`;
}


export const RATE_LIMIT_COMMENT =
  "You're done for today. This installation hit the free-tier cap. Try again tomorrow (or raise \`DAILY_ROAST_LIMIT\` if you self-host).";

export const QUOTA_COMMENT =
  "Every free-tier model is rate-limited or out of quota. Try again later.";

export const ERROR_COMMENT =
  "Something broke while reviewing. Check the Worker logs.";
