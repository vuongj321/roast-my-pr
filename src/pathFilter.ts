/**
 * Light post-filter: drop roast bullets that cite file paths not present
 * in the packed diff. Does not require Evidence quotes.
 */

import { extractCitedPaths, matchesPriorityPath } from "./diffPack.js";
import type { FindingStatus, PriorFinding } from "./types.js";

export const PATH_STRIPPED_NOTE =
  "_Note: Some bullets cited files that were not in the packed diff and were omitted._";

export const INCOMPLETE_PACK_NOTE =
  "_Note: The model only cited files outside the packed diff, so detailed bullets were omitted. The review may be incomplete._";

export const ABSOLUTE_CLAIM_STRIPPED_NOTE =
  "_Note: Some absolute claims lacked a quote present in the packed diff and were omitted._";

export const INTENT_FIXIT_STRIPPED_NOTE =
  "_Note: Some Fix-it bullets contradicted stated commit constraints and were omitted._";

/** Split a section body into bullet blocks (`-` / `*` / numbered). */
export function splitBulletBlocks(sectionBody: string): string[] {
  const lines = sectionBody.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];

  const flush = () => {
    const text = current.join("\n").trim();
    if (text) blocks.push(text);
    current = [];
  };

  for (const line of lines) {
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flush();
      current.push(line);
    } else if (current.length > 0) {
      if (/^\s*$/.test(line) || /^\s+\S/.test(line)) {
        current.push(line);
      } else {
        flush();
      }
    }
  }
  flush();
  return blocks;
}

function sectionBulletsAndTail(body: string): { blocks: string[]; tail: string } {
  const blocks = splitBulletBlocks(body);
  if (blocks.length === 0) return { blocks: [], tail: body.trim() };
  const last = blocks[blocks.length - 1]!;
  const idx = body.lastIndexOf(last);
  if (idx < 0) return { blocks, tail: "" };
  const after = body.slice(idx + last.length).trim();
  return { blocks, tail: after };
}

type SectionName = "sendBack" | "fixIt" | "other";

function classifyHeading(line: string): SectionName | null {
  const t = line.replace(/^#+\s*/, "").trim().toLowerCase();
  if (/what i'?d send back/.test(t)) return "sendBack";
  if (/^fix it\b/.test(t)) return "fixIt";
  if (
    /^#{1,3}\s/.test(line.trim()) ||
    /^\*\*[^*]+\*\*\s*$/.test(line.trim())
  ) {
    return "other";
  }
  return null;
}

type ParsedRoast = {
  raw: string;
  preamble: string[];
  sendBackBlocks: string[];
  fixItBlocks: string[];
  trailing: string[];
  structured: boolean;
};

function parseRoastSections(roastText: string): ParsedRoast {
  const raw = (roastText || "").trim();
  const preamble: string[] = [];
  const sendBackBlocks: string[] = [];
  const fixItBlocks: string[] = [];
  const trailing: string[] = [];

  if (!raw) {
    return {
      raw,
      preamble,
      sendBackBlocks,
      fixItBlocks,
      trailing,
      structured: false,
    };
  }

  const lines = raw.split(/\r?\n/);
  let mode: "preamble" | "sendBack" | "fixIt" | "trailing" = "preamble";
  let sectionBuf: string[] = [];

  const flushSection = () => {
    const body = sectionBuf.join("\n");
    sectionBuf = [];
    if (mode === "sendBack") {
      const { blocks, tail } = sectionBulletsAndTail(body);
      sendBackBlocks.push(...blocks);
      if (tail) trailing.push(tail);
    } else if (mode === "fixIt") {
      const { blocks, tail } = sectionBulletsAndTail(body);
      fixItBlocks.push(...blocks);
      if (tail) trailing.push(tail);
    } else if (mode === "trailing") {
      trailing.push(body);
    }
  };

  for (const line of lines) {
    const heading = classifyHeading(line);
    if (heading === "sendBack") {
      if (mode !== "preamble") flushSection();
      mode = "sendBack";
      sectionBuf = [];
      continue;
    }
    if (heading === "fixIt") {
      flushSection();
      mode = "fixIt";
      sectionBuf = [];
      continue;
    }
    if (heading === "other" && (mode === "sendBack" || mode === "fixIt")) {
      flushSection();
      mode = "trailing";
      sectionBuf = [line];
      continue;
    }

    if (mode === "preamble") {
      preamble.push(line);
    } else {
      sectionBuf.push(line);
    }
  }
  flushSection();

  return {
    raw,
    preamble,
    sendBackBlocks,
    fixItBlocks,
    trailing,
    structured: sendBackBlocks.length > 0 || fixItBlocks.length > 0,
  };
}

function rebuildRoastSections(
  parsed: ParsedRoast,
  keptSend: string[],
  keptFix: string[],
  dropped: number,
  notes: { some: string; all: string },
): { text: string; kept: number; dropped: number } {
  const kept = keptSend.length + keptFix.length;
  const parts: string[] = [];
  if (dropped > 0 && kept === 0) {
    parts.push(notes.all, "");
  } else if (dropped > 0) {
    parts.push(notes.some, "");
  }

  const pre = parsed.preamble.join("\n").trim();
  if (pre) parts.push(pre, "");

  if (keptSend.length > 0) {
    parts.push("### What I'd send back", ...keptSend, "");
  }
  if (keptFix.length > 0) {
    parts.push("### Fix it", ...keptFix, "");
  }

  const trail = parsed.trailing.join("\n").trim();
  if (trail) parts.push(trail);

  const text = parts.join("\n").trim();
  return {
    text: text || parsed.raw,
    kept,
    dropped,
  };
}

/** True if every path cited in the bullet is among packed filenames. */
export function bulletPathsArePacked(
  block: string,
  packedFilenames: ReadonlySet<string> | readonly string[],
): boolean {
  const packed =
    packedFilenames instanceof Set
      ? packedFilenames
      : new Set(packedFilenames);
  const cited = extractCitedPaths(block);
  if (cited.length === 0) return true;
  return cited.every((p) => matchesPriorityPath(p, packed));
}

/**
 * Filter roast markdown: drop bullets that cite paths outside the packed set.
 * Always returns postable text (never fails the provider).
 */
export function filterRoastByPackedPaths(
  roastText: string,
  packedFilenames: ReadonlySet<string> | readonly string[],
): { text: string; kept: number; dropped: number } {
  const parsed = parseRoastSections(roastText);
  if (!parsed.structured) {
    return { text: parsed.raw, kept: 0, dropped: 0 };
  }

  let dropped = 0;
  const filterBlocks = (blocks: string[]): string[] => {
    const kept: string[] = [];
    for (const block of blocks) {
      if (bulletPathsArePacked(block, packedFilenames)) {
        kept.push(block);
      } else {
        dropped += 1;
      }
    }
    return kept;
  };

  return rebuildRoastSections(
    parsed,
    filterBlocks(parsed.sendBackBlocks),
    filterBlocks(parsed.fixItBlocks),
    dropped,
    { some: PATH_STRIPPED_NOTE, all: INCOMPLETE_PACK_NOTE },
  );
}

/** Absolute / unverifiable confidence language that needs a packed-diff quote. */
const ABSOLUTE_CLAIM_RE =
  /\b(never|unused|unapplied|not applied|no guard|blindly|hard-?codes?|definitely|clearly never|compiler will|will error|placeholders? for future|not a finished feature)\b/i;

/** Minimum length for a backtick/quote span to count as evidence. */
const MIN_EVIDENCE_SPAN = 6;

/** Pull candidate evidence spans from backticks and double-quoted strings. */
export function extractEvidenceSpans(block: string): string[] {
  const spans: string[] = [];
  const backtick = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = backtick.exec(block)) !== null) {
    const s = m[1]!.trim();
    if (s.length >= MIN_EVIDENCE_SPAN) spans.push(s);
  }
  const quoted = /"([^"\n]{6,})"/g;
  while ((m = quoted.exec(block)) !== null) {
    spans.push(m[1]!.trim());
  }
  return spans;
}

/** True when an absolute-claim bullet cites a span that appears in the packed diff. */
export function absoluteClaimHasPackedEvidence(
  block: string,
  packedDiff: string,
): boolean {
  if (!ABSOLUTE_CLAIM_RE.test(block)) return true;
  const packed = packedDiff || "";
  if (!packed.trim()) return false;
  for (const span of extractEvidenceSpans(block)) {
    if (packed.includes(span)) return true;
    // Soft match: collapse whitespace for multi-line code fragments.
    const soft = span.replace(/\s+/g, " ").trim();
    if (soft.length >= MIN_EVIDENCE_SPAN && packed.replace(/\s+/g, " ").includes(soft)) {
      return true;
    }
  }
  return false;
}

/**
 * Drop send-back / Fix-it bullets that make absolute claims without quoting
 * something that literally appears in the packed diff.
 */
export function filterUnverifiedAbsoluteClaims(
  roastText: string,
  packedDiff: string,
): { text: string; kept: number; dropped: number } {
  const parsed = parseRoastSections(roastText);
  if (!parsed.structured) {
    return { text: parsed.raw, kept: 0, dropped: 0 };
  }

  let dropped = 0;
  const filterBlocks = (blocks: string[]): string[] => {
    const kept: string[] = [];
    for (const block of blocks) {
      if (absoluteClaimHasPackedEvidence(block, packedDiff)) {
        kept.push(block);
      } else {
        dropped += 1;
      }
    }
    return kept;
  };

  return rebuildRoastSections(
    parsed,
    filterBlocks(parsed.sendBackBlocks),
    filterBlocks(parsed.fixItBlocks),
    dropped,
    {
      some: ABSOLUTE_CLAIM_STRIPPED_NOTE,
      all: ABSOLUTE_CLAIM_STRIPPED_NOTE,
    },
  );
}

/** Commit subjects that look like deliberate constraints / tradeoffs. */
const CONSTRAINT_COMMIT_RE =
  /\b(cannot|can't|won't|will not|append-?only|intentionally|keep unused|no kv|footer|hidden state|out of scope|trade-?off|accepted risk|we chose|not doing|postgres cannot)\b/i;

/** Fix-it language that undoes a documented constraint. */
const UNDO_CONSTRAINT_RE =
  /\b(drop (?:the )?(?:enum|values|legacy)|remove (?:the )?(?:hidden |state |footer|comment)|reinstate|undo|delete (?:the )?state|serialize (?:in|as) (?:a )?json|dedicated json)\b/i;

type ConstraintTopic = "enum" | "state";

function constraintTopics(text: string): Set<ConstraintTopic> {
  const t = text.toLowerCase();
  const topics = new Set<ConstraintTopic>();
  if (/enum|postgres|append/.test(t)) topics.add("enum");
  if (/footer|state|hidden|kv|comment/.test(t)) topics.add("state");
  return topics;
}

/**
 * Drop Fix-it bullets that demand undoing a constraint stated in commit subjects.
 */
export function dropIntentContradictingFixIts(
  roastText: string,
  commitMessages: readonly string[],
): { text: string; kept: number; dropped: number } {
  const parsed = parseRoastSections(roastText);
  if (!parsed.structured || parsed.fixItBlocks.length === 0) {
    return { text: parsed.raw, kept: 0, dropped: 0 };
  }

  const constraints = (commitMessages ?? []).filter((m) =>
    CONSTRAINT_COMMIT_RE.test(m),
  );
  if (constraints.length === 0) {
    return { text: parsed.raw, kept: 0, dropped: 0 };
  }

  const stated = new Set<ConstraintTopic>();
  for (const c of constraints) {
    for (const topic of constraintTopics(c)) stated.add(topic);
  }
  if (stated.size === 0) {
    return { text: parsed.raw, kept: 0, dropped: 0 };
  }

  let dropped = 0;
  const keptFix: string[] = [];
  for (const block of parsed.fixItBlocks) {
    if (!UNDO_CONSTRAINT_RE.test(block)) {
      keptFix.push(block);
      continue;
    }
    const bulletTopics = constraintTopics(block);
    const contradicts = [...bulletTopics].some((t) => stated.has(t));
    if (contradicts) {
      dropped += 1;
      continue;
    }
    keptFix.push(block);
  }

  if (dropped === 0) {
    return { text: parsed.raw, kept: 0, dropped: 0 };
  }

  return rebuildRoastSections(
    parsed,
    parsed.sendBackBlocks,
    keptFix,
    dropped,
    {
      some: INTENT_FIXIT_STRIPPED_NOTE,
      all: INTENT_FIXIT_STRIPPED_NOTE,
    },
  );
}

/** Roast bullets are treated as a repeat above this many shared keywords. */
const REPEAT_MIN_SHARED_WORDS = 2;

/**
 * `- F1 resolved` / `- F2 still present — "quoted line"` accounting lines that
 * the prompt asks for at the top of the reply.
 */
const ACCOUNTING_RE =
  /^\s*(?:[-*+]|\d+\.)?\s*\**\s*(F\d+)\b[^A-Za-z]*(resolved|fixed|done|still\s*present|still\s*broken|unfixed|unverifiable|unknown|not\s*shown)\b/i;

/** Words too generic to prove two findings are the same complaint. */
const STOP_WORDS = new Set([
  "the", "and", "that", "this", "with", "from", "your", "you", "are", "was",
  "were", "for", "not", "but", "its", "has", "have", "had", "using", "use",
  "uses", "used", "into", "when", "what", "which", "there", "their", "them",
  "then", "than", "also", "just", "only", "over", "under", "about", "after",
  "before", "because", "should", "would", "could", "must", "does", "did",
  "doing", "been", "being", "all", "any", "can", "will", "they", "these",
  "those", "where", "while", "whom", "whose", "how", "why", "out", "off",
  "own", "same", "too", "very", "more", "most", "much", "many", "some",
  "such", "each", "both", "few", "other", "another", "again", "once", "here",
  "now", "make", "makes", "made", "get", "gets", "got", "lets", "instead",
  "without", "within", "across", "between", "though", "however", "per", "via",
  "code", "file", "files", "line", "lines", "path", "paths", "calls", "call",
  "called", "throws", "throw",
]);

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[`*_#>\[\](){}'"]/g, " ")
      .split(/[^a-z0-9_.-]+/)
      .filter(
        (word) =>
          word.length > 3 && !word.includes("/") && !STOP_WORDS.has(word),
      ),
  );
}

/**
 * Words with cited file paths removed. Two findings about different bugs in the
 * same file share the path tokens, which would look like a repeat.
 */
function wordsWithoutPaths(text: string): Set<string> {
  let stripped = text;
  for (const path of extractCitedPaths(text)) {
    stripped = stripped.split(path).join(" ");
    const base = path.split("/").pop();
    if (base) stripped = stripped.split(base).join(" ");
  }
  return significantWords(stripped);
}

/**
 * Pull the model's finding accounting out of a roast and return the roast
 * without those lines (they are bookkeeping, not review prose).
 */
export function parseFindingAccounting(roastText: string): {
  accounting: Map<string, FindingStatus>;
  text: string;
} {
  const accounting = new Map<string, FindingStatus>();
  const kept: string[] = [];

  for (const line of (roastText || "").split(/\r?\n/)) {
    const match = line.match(ACCOUNTING_RE);
    if (!match) {
      kept.push(line);
      continue;
    }
    const id = match[1]!.toUpperCase();
    const word = match[2]!.toLowerCase().replace(/\s+/g, "");
    const status: FindingStatus =
      word === "resolved" || word === "fixed" || word === "done"
        ? "resolved"
        : word === "unverifiable" || word === "unknown" || word === "notshown"
          ? "unverifiable"
          : "stillPresent";
    accounting.set(id, status);
  }

  const text = kept
    .join("\n")
    .replace(/\n*#{1,6}[^\n]*\b(prior findings?|accounting|verification)\b[^\n]*\n/gi, "\n")
    .trim();
  return { accounting, text };
}

/** True when this bullet looks like the same complaint as `finding`. */
export function bulletRepeatsFinding(
  bullet: string,
  finding: PriorFinding,
): boolean {
  const bulletWords = wordsWithoutPaths(bullet);
  const findingWords = wordsWithoutPaths(finding.text);
  let shared = 0;
  for (const word of bulletWords) {
    if (findingWords.has(word)) shared += 1;
  }
  if (shared === 0) return false;

  const cited = extractCitedPaths(bullet);
  if (finding.path) {
    const sameFile = cited.some((p) =>
      matchesPriorityPath(p, new Set([finding.path!])),
    );
    if (sameFile) return shared >= REPEAT_MIN_SHARED_WORDS;
    if (cited.length > 0) return false;
  }
  return shared > REPEAT_MIN_SHARED_WORDS;
}

/**
 * Safety net for self-contradiction: if the model marked a finding resolved and
 * then raised it again in a bullet, drop the bullet.
 *
 * Deliberately conservative — a repeat the model never declared resolved is left
 * alone (the prompt and the review delta are what stop those, not a regex).
 */
export function dropResolvedRepeats(
  roastText: string,
  priorFindings: readonly PriorFinding[] | undefined,
  accounting: ReadonlyMap<string, FindingStatus>,
): { text: string; dropped: number } {
  const text = (roastText || "").trim();
  if (!text || !priorFindings?.length || accounting.size === 0) {
    return { text, dropped: 0 };
  }

  const resolved = priorFindings.filter(
    (f) => accounting.get(f.id.toUpperCase()) === "resolved",
  );
  if (resolved.length === 0) return { text, dropped: 0 };

  const kept: string[] = [];
  let dropped = 0;
  for (const line of text.split(/\r?\n/)) {
    const isBullet = /^\s*(?:[-*+]|\d+\.)\s+\S/.test(line);
    if (isBullet && resolved.some((f) => bulletRepeatsFinding(line, f))) {
      dropped += 1;
      continue;
    }
    kept.push(line);
  }

  if (dropped === 0) return { text, dropped: 0 };

  // Collapse blank runs left behind by removed bullets.
  const cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: cleaned || text, dropped };
}

/** Closers that judge the review's epistemic status instead of the code. */
const HEDGE_CLOSER_RE =
  /\b(grain of salt|i may be wrong|take this lightly|limited view|for what it'?s worth|when (?:the )?code compiles|when it compiles|need (?:the )?full context|diff is incomplete|we can'?t be sure|n% of the (?:pr|diff)|%\s*of the (?:pr|diff)|trust (?:this|nothing)|epistemic|rest of the diff|read the rest|see the real problems|real problems|incomplete review|for a complete review)\b/i;

/**
 * Drop a trailing paragraph that hedges the review itself. The partial-review
 * banner already covers coverage honesty; the closer should judge the code.
 */
export function stripHedgeCloser(roastText: string): {
  text: string;
  stripped: boolean;
} {
  const text = (roastText || "").trim();
  if (!text) return { text, stripped: false };

  const paragraphs = text.split(/\n\s*\n/);
  if (paragraphs.length < 2) {
    // Single block: only strip if the last non-empty line alone is a hedge.
    const lines = text.split(/\r?\n/);
    let lastIdx = lines.length - 1;
    while (lastIdx >= 0 && !lines[lastIdx]!.trim()) lastIdx -= 1;
    if (lastIdx < 0) return { text, stripped: false };
    const last = lines[lastIdx]!.trim();
    if (
      !/^\s*(?:[-*+]|\d+\.)\s+/.test(last) &&
      !/^#{1,6}\s/.test(last) &&
      HEDGE_CLOSER_RE.test(last)
    ) {
      const kept = lines.slice(0, lastIdx).join("\n").trim();
      return { text: kept || text, stripped: true };
    }
    return { text, stripped: false };
  }

  const last = paragraphs[paragraphs.length - 1]!.trim();
  // Don't strip structured sections — only short closer-like paragraphs.
  if (
    /^\s*(?:[-*+]|\d+\.)\s+/m.test(last) ||
    /^#{1,6}\s/m.test(last) ||
    /^###\s/m.test(last)
  ) {
    return { text, stripped: false };
  }
  if (!HEDGE_CLOSER_RE.test(last)) return { text, stripped: false };

  const kept = paragraphs.slice(0, -1).join("\n\n").trim();
  return { text: kept || text, stripped: true };
}
