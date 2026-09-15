/**
 * Light post-filter: drop roast bullets that cite file paths not present
 * in the packed diff. Does not require Evidence quotes.
 */

import { extractCitedPaths, matchesPriorityPath } from "./diffPack.js";

export const PATH_STRIPPED_NOTE =
  "_Note: Some bullets cited files that were not in the packed diff and were omitted._";

export const INCOMPLETE_PACK_NOTE =
  "_Note: The model only cited files outside the packed diff, so detailed bullets were omitted. The review may be incomplete._";

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
  const raw = (roastText || "").trim();
  if (!raw) {
    return { text: raw, kept: 0, dropped: 0 };
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

  let keptSend: string[] = [];
  let keptFix: string[] = [];
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

  const structured = sendBackBlocks.length > 0 || fixItBlocks.length > 0;
  if (!structured) {
    // No recognizable sections — leave the roast as-is.
    return { text: raw, kept: 0, dropped: 0 };
  }

  keptSend = filterBlocks(sendBackBlocks);
  keptFix = filterBlocks(fixItBlocks);
  const kept = keptSend.length + keptFix.length;

  const parts: string[] = [];
  if (dropped > 0 && kept === 0) {
    parts.push(INCOMPLETE_PACK_NOTE, "");
  } else if (dropped > 0) {
    parts.push(PATH_STRIPPED_NOTE, "");
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

  const text = parts.join("\n").trim();
  return {
    text: text || raw,
    kept,
    dropped,
  };
}
