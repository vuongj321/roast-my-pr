/**
 * Normalize free-tier chat/completion JSON into plain text.
 * Prefer answer `content`; only accept reasoning fields when they look finished.
 *
 * Providers sometimes answer with their own scratchpad instead of the roast
 * ("Drafting the specific insults", "PR Title: …", "I'll focus on …"). That is
 * not a review, so it must never reach a comment — see `isPlanningDump`.
 */

function coerceContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") return p.text;
        if (typeof p.content === "string") return p.content;
      }
      return "";
    })
    .join("")
    .trim();
}

/** Start of a bullet at the beginning of a line (markdown `-`/`*`/`1.`). */
const BULLET = "^[\\t ]*(?:[-*+]|\\d+\\.)[\\t ]+";

/**
 * A bullet that is *nothing but* a short label: `- Key Changes:`, `*Closer*:`.
 * Backticks are excluded so a lead-in bullet that ends the line on purpose
 * (`` * `src/a.ts`: `` followed by nested bullets) is not mistaken for one.
 */
const LABEL_ONLY_BULLET_RE = new RegExp(
  `${BULLET}\\*{1,2}[^*\\n\`]{2,40}\\*{1,2}[\\t ]*$|${BULLET}[A-Z][^*\\n:\`]{2,40}:[\\t ]*$`,
  "m",
);

/**
 * Bullets labelled with a *process* step rather than a review point. These read
 * as planning ("*Refining \"Fix it\"*:", "*Closer*:", "*Wait, check …*:"), so
 * they mark the whole reply as scratchpad even when it also carries a real
 * section heading — which is exactly how a planning dump slipped out as a roast.
 */
const PLANNING_LABEL_WORDS =
  "drafts?|drafting|refin\\w+|reviewing|looking at|closer|wait|key changes|potential issues?|self-?check|summar\\w+";

const PLANNING_LABEL_RE = new RegExp(
  `${BULLET}\\*{0,2}(?:${PLANNING_LABEL_WORDS})\\b[^*\\n]{0,60}\\*{0,2}:`,
  "im",
);

/**
 * The user prompt's own field names. A bullet repeating "PR Title: …" /
 * "Author: @x" is prompt structure echoed back, never a finding.
 */
const PROMPT_ECHO_RE = new RegExp(
  `${BULLET}\\*{0,2}(?:pr title|author|repository|pr #\\d*|files in detailed diff)\\b[^*\\n]{0,60}\\*{0,2}:`,
  "im",
);

/**
 * First-person narration of the review process ("I'll focus on…", "Wait,
 * check…", "Actually, it's not that bad."). A finished roast talks about the
 * diff, not about what the model is about to write.
 */
const PLANNING_NARRATION_RE =
  /\bi'?ll focus\b|\blet me (?:re-?check|re-?read|double-?check)\b|\bwait, (?:check|looking|look)\b|\bactually, (?:it'?s|that'?s|this is) (?:not that bad|fine|readable)\b|\bthis (?:seems|looks) (?:okay|fine|reasonable) but\b/i;

/**
 * True when the text contains a line that is a planning label, a prompt-field
 * echo, or a label-only bullet. Safe to run on a single finding block or on a
 * whole reply.
 */
export function isPlanningLabel(text: string): boolean {
  return (
    LABEL_ONLY_BULLET_RE.test(text) ||
    PLANNING_LABEL_RE.test(text) ||
    PROMPT_ECHO_RE.test(text)
  );
}

/** True when text looks like the finished roast markdown, not planning notes. */
export function looksLikeFinishedRoast(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/what i'?d (?:send|push) back|what i would (?:send|push) back/i.test(t)) {
    return true;
  }
  if (
    /^\s*(?:#{1,4}\s+\S|\*\*[^*\n]{3,80}\*\*)/m.test(t) &&
    /^\s*[-*+]\s+/m.test(t) &&
    /`[^`]+\/[^`]+`/.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * True when the model dumped planning/CoT instead of the roast markdown format.
 */
export function isPlanningDump(text: string): boolean {
  const t = text.trim();
  if (!t) return false;

  const looksLikeCot =
    (/analyze the request/i.test(t) && /drafting the response/i.test(t)) ||
    /mental scan for issues/i.test(t) ||
    (/\*\*role:\*\*/i.test(t) && /\*\*constraint\s*\d+/i.test(t)) ||
    /^\s*1\.\s*\*\*analyze/i.test(t) ||
    /we need to produce a roast/i.test(t) ||
    /let'?s scan (the )?diff/i.test(t);

  return looksLikeCot || isPlanningLabel(t) || PLANNING_NARRATION_RE.test(t);
}

/**
 * Text that is not a planning dump. Kept as a separate name because the
 * reasoning-field path checks it independently of the finish/structure gate.
 */
export function isUsableRoastText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return !isPlanningDump(t);
}

/**
 * The full bar for a comment: a structured review, not a dump, not cut off.
 * Section headings are what every real roast has carried, so a reply without
 * one is treated as unusable and the chain falls through to the next provider.
 */
export function isPostableRoast(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (isPlanningDump(t)) return false;
  if (isTruncatedRoastText(t)) return false;
  return looksLikeFinishedRoast(t);
}

/**
 * Heuristic for replies cut off mid-sentence (e.g. MAX_TOKENS after thinking).
 */
export function isTruncatedRoastText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Ends on a conjunction / preposition / article — classic hard cut.
  if (
    /\b(the|a|an|and|or|but|to|of|in|for|with|into|from|by|as|at|on|is|are|was|were|be|been|being|that|this|these|those|which|who|whom|whose|if|when|while|where|than|then|so|not|no|nor|yet)\s*$/i.test(
      t,
    )
  ) {
    return true;
  }
  // Ends on open punctuation / incomplete markdown fence.
  if (/[,:;(\[{\-–—]\s*$/.test(t)) return true;
  if (/```\w*\s*$/.test(t)) return true;
  // Unclosed inline code or bold (odd delimiter count).
  const ticks = t.match(/`/g);
  if (ticks && ticks.length % 2 === 1) return true;
  const bolds = t.match(/\*\*/g);
  if (bolds && bolds.length % 2 === 1) return true;
  return false;
}

type AnswerCandidate = {
  text: string;
  /** Reasoning fields carry planning most of the time, so they get extra checks. */
  field: "content" | "reasoning";
};

/**
 * Every place an answer can hide, in preference order. Kept ungated so the
 * caller can iterate (a dump in `content` may sit next to a real `response`).
 */
function answerCandidates(data: unknown): AnswerCandidate[] {
  const out: AnswerCandidate[] = [];
  const push = (text: string, field: AnswerCandidate["field"]): void => {
    if (text) out.push({ text, field });
  };

  if (typeof data === "string") {
    push(data, "content");
    return out;
  }
  if (data == null || typeof data !== "object") return out;

  const obj = data as Record<string, unknown>;

  const choices = obj.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    const c0 = choices[0] as Record<string, unknown>;
    const message =
      c0.message && typeof c0.message === "object"
        ? (c0.message as Record<string, unknown>)
        : undefined;
    if (message) {
      push(coerceContent(message.content), "content");
      push(
        coerceContent(message.reasoning) ||
          coerceContent(message.reasoning_content),
        "reasoning",
      );
    }
    push(coerceContent(c0.text), "content");
    const delta =
      c0.delta && typeof c0.delta === "object"
        ? (c0.delta as Record<string, unknown>)
        : undefined;
    if (delta) push(coerceContent(delta.content), "content");
  }

  for (const key of ["response", "result", "output", "text"] as const) {
    const value = obj[key];
    if (typeof value === "string") push(value, "content");
  }

  return out;
}

function acceptContent(text: string): string {
  const t = text.trim();
  if (!t) return "";
  return isPostableRoast(t) ? t : "";
}

function acceptReasoning(text: string): string {
  const t = text.trim();
  if (!t || !isUsableRoastText(t) || isTruncatedRoastText(t)) return "";
  // Only post reasoning when it is clearly the finished review.
  return looksLikeFinishedRoast(t) ? t : "";
}

/**
 * Pull assistant *answer* text from OpenAI-style or Workers AI payloads.
 * Uses `content` first. Falls back to `reasoning` / `reasoning_content` only
 * when that text looks like a finished roast (never raw planning dumps).
 */
export function extractModelText(data: unknown): string {
  for (const candidate of answerCandidates(data)) {
    const accepted =
      candidate.field === "reasoning"
        ? acceptReasoning(candidate.text)
        : acceptContent(candidate.text);
    if (accepted) return accepted;
  }
  return "";
}

/**
 * The first raw answer text, before any gate. Diagnostics only: an empty
 * `extractModelText` result is a planning dump, not a size problem, when this
 * text trips `isPlanningDump` — which decides whether a shrink retry is useless.
 */
export function rawAnswerText(data: unknown): string {
  return answerCandidates(data)[0]?.text.trim() ?? "";
}

/** Log a clipped payload when a provider returns no usable text. */
export function logEmptyCompletionPayload(
  provider: string,
  data: unknown,
): void {
  try {
    const raw = typeof data === "string" ? data : JSON.stringify(data);
    const clipped =
      raw.length > 800 ? `${raw.slice(0, 800)}…[clipped]` : raw;
    console.error(
      `Roast provider ${provider}: empty completion payload: ${clipped}`,
    );
  } catch {
    console.error(
      `Roast provider ${provider}: empty completion (unserializable payload)`,
    );
  }
}
