/**
 * Normalize free-tier chat/completion JSON into plain text.
 * Prefer answer `content`; only accept reasoning fields when they look finished.
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

/** True when text looks like the finished roast markdown, not planning notes. */
export function looksLikeFinishedRoast(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/what i'?d send back/i.test(t)) return true;
  if (
    /^#\s+\S/m.test(t) &&
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
export function isUsableRoastText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;

  const looksLikeCot =
    (/analyze the request/i.test(t) && /drafting the response/i.test(t)) ||
    /mental scan for issues/i.test(t) ||
    (/\*\*role:\*\*/i.test(t) && /\*\*constraint\s*\d+/i.test(t)) ||
    /^\s*1\.\s*\*\*analyze/i.test(t) ||
    /we need to produce a roast/i.test(t) ||
    /let'?s scan (the )?diff/i.test(t);

  if (looksLikeCot) return false;
  return true;
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

function acceptAnswer(text: string): string {
  const t = text.trim();
  if (!t) return "";
  if (!isUsableRoastText(t) || isTruncatedRoastText(t)) return "";
  return t;
}

/**
 * Pull assistant *answer* text from OpenAI-style or Workers AI payloads.
 * Uses `content` first. Falls back to `reasoning` / `reasoning_content` only
 * when that text looks like a finished roast (never raw planning dumps).
 */
export function extractModelText(data: unknown): string {
  if (data == null) return "";
  if (typeof data === "string") return acceptAnswer(data);
  if (typeof data !== "object") return "";

  const obj = data as Record<string, unknown>;

  const choices = obj.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    const c0 = choices[0] as Record<string, unknown>;
    const message =
      c0.message && typeof c0.message === "object"
        ? (c0.message as Record<string, unknown>)
        : undefined;
    if (message) {
      const fromContent = acceptAnswer(coerceContent(message.content));
      if (fromContent) return fromContent;

      const fromReason = acceptAnswer(
        coerceContent(message.reasoning) ||
          coerceContent(message.reasoning_content),
      );
      // Only post reasoning when it is clearly the finished review.
      if (fromReason && looksLikeFinishedRoast(fromReason)) return fromReason;
    }
    const fromText = acceptAnswer(coerceContent(c0.text));
    if (fromText) return fromText;
    const delta =
      c0.delta && typeof c0.delta === "object"
        ? (c0.delta as Record<string, unknown>)
        : undefined;
    if (delta) {
      const fromDelta = acceptAnswer(coerceContent(delta.content));
      if (fromDelta) return fromDelta;
    }
  }

  for (const key of ["response", "result", "output", "text"] as const) {
    const value = obj[key];
    if (typeof value === "string") {
      const accepted = acceptAnswer(value);
      if (accepted) return accepted;
    }
  }

  return "";
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
