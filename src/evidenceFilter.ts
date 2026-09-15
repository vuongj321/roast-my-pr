/**
 * Drop roast bullets whose Evidence quotes are not present in the packed diff.
 * Soft prompt rules are not enough for weak free-tier failover models.
 */

export const MIN_EVIDENCE_CHARS = 12;

export const UNSUBSTANTIATED_FALLBACK =
  "Could not substantiate findings against the packed diff. Every claim lacked a verbatim quote that appears in the provided code—or the model invented the quotes.";

export const STRIPPED_NOTE =
  "_Note: Unsupported claims (missing or unverifiable Evidence quotes) were stripped._";

const EVIDENCE_RE = /Evidence:\s*`([^`]+)`/i;

export function normalizeForEvidenceMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function evidenceAppearsInDiff(
  evidence: string,
  packedDiff: string,
): boolean {
  const needle = normalizeForEvidenceMatch(evidence);
  if (needle.length < MIN_EVIDENCE_CHARS) return false;
  return normalizeForEvidenceMatch(packedDiff).includes(needle);
}

export function extractEvidenceQuote(block: string): string | null {
  const match = EVIDENCE_RE.exec(block);
  return match?.[1]?.trim() || null;
}

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
      // Continuations: blank lines, indented wraps, or Evidence on the next line.
      if (
        /^\s*$/.test(line) ||
        /^\s+\S/.test(line) ||
        /^\s*Evidence:/i.test(line)
      ) {
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
  if (/^#{1,3}\s/.test(line.trim()) || /^\*\*[^*]+\*\*\s*$/.test(line.trim())) {
    return "other";
  }
  return null;
}

/**
 * Filter roast markdown: keep send-back / fix-it bullets only when Evidence
 * is present and appears in packedDiff.
 */
export function filterRoastByEvidence(
  roastText: string,
  packedDiff: string,
): { text: string; kept: number; dropped: number } {
  const raw = (roastText || "").trim();
  if (!raw) {
    return { text: UNSUBSTANTIATED_FALLBACK, kept: 0, dropped: 0 };
  }

  const lines = raw.split(/\r?\n/);
  const preamble: string[] = [];
  const sendBackBlocks: string[] = [];
  const fixItBlocks: string[] = [];
  const trailing: string[] = [];

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
      if (mode === "preamble") {
        // keep preamble as-is
      } else {
        flushSection();
      }
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

  // If we never found structured sections, try filtering all top-level bullets.
  let keptSend: string[] = [];
  let keptFix: string[] = [];
  let dropped = 0;

  const filterBlocks = (blocks: string[]): string[] => {
    const kept: string[] = [];
    for (const block of blocks) {
      const quote = extractEvidenceQuote(block);
      if (quote && evidenceAppearsInDiff(quote, packedDiff)) {
        kept.push(block);
      } else {
        dropped += 1;
      }
    }
    return kept;
  };

  if (sendBackBlocks.length === 0 && fixItBlocks.length === 0) {
    const all = splitBulletBlocks(raw);
    if (all.length === 0) {
      return { text: UNSUBSTANTIATED_FALLBACK, kept: 0, dropped: 0 };
    }
    keptSend = filterBlocks(all);
  } else {
    keptSend = filterBlocks(sendBackBlocks);
    // Fix-it: keep only bullets with matching Evidence; drop Evidence-less fix items.
    keptFix = filterBlocks(fixItBlocks);
  }

  const kept = keptSend.length + keptFix.length;
  if (kept === 0) {
    return { text: UNSUBSTANTIATED_FALLBACK, kept: 0, dropped };
  }

  const parts: string[] = [];
  if (kept < 2) {
    parts.push(STRIPPED_NOTE, "");
  }

  const pre = preamble.join("\n").trim();
  if (pre) parts.push(pre, "");

  if (keptSend.length > 0) {
    parts.push("### What I'd send back", ...keptSend, "");
  }
  if (keptFix.length > 0) {
    parts.push("### Fix it", ...keptFix, "");
  }

  const trail = trailing.join("\n").trim();
  if (trail) parts.push(trail);

  return {
    text: parts.join("\n").trim(),
    kept,
    dropped,
  };
}
