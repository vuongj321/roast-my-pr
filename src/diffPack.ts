/**
 * Pack PR file patches into a prompt-sized budget.
 *
 * Free-tier providers (especially Groq) reject oversized prompts, so we:
 * - drop noisy / generated files
 * - prefer source over lockfiles and assets
 * - cap each file and the total
 * - clip by *hunk* (not by tail of patch), so fixes deep in a file survive
 * - keep an inventory of what was omitted and what was only partially shown
 */

export type DiffFile = {
  filename: string;
  status: string;
  patch?: string | null;
};

export type PackOptions = {
  /** Max characters for packed file patches (inventory is appended after). */
  maxTotalChars: number;
  /** Max characters of patch text kept per file. */
  maxPerFileChars: number;
  /** Max characters kept from the PR description. */
  maxBodyChars: number;
};

/** A file whose patch only partly fitted the budget. */
export type PartialFile = {
  filename: string;
  shownChars: number;
  totalChars: number;
  hunksShown: number;
  hunksTotal: number;
};

export type PackedContext = {
  body: string;
  diff: string;
  truncated: boolean;
  includedFiles: number;
  /** Filenames that received a detailed pack block. */
  includedFilenames: string[];
  totalFiles: number;
  omitted: Array<{ filename: string; reason: string }>;
  /** Files shown with hunks dropped — absence of code there proves nothing. */
  partialFiles: PartialFile[];
  /** Patch characters shown to the model (coverage signal for the footer). */
  shownPatchChars: number;
  /** Patch characters across all reviewable (non-noise) files. */
  totalPatchChars: number;
};

/** One `@@` hunk of a file patch (or the whole patch when it has no headers). */
export type Hunk = {
  text: string;
  /** Added-line count; added code is where fixes live, so it ranks highest. */
  added: number;
  /** Position in the original patch, 0-based. */
  index: number;
};

const SKIP_BASENAME =
  /^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|Pipfile\.lock|go\.sum)$/i;

const SKIP_EXTENSION =
  /\.(min\.(js|css)|map|snap|wasm|bin|exe|dll|so|dylib|png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|tar|rar|7z|mp4|webm|mp3|wav|woff2?|ttf|eot|psd|ai)$/i;

const SKIP_PATH =
  /(^|\/)(dist|build|coverage|\.next|out|vendor|node_modules|\.turbo|\.cache|storybook-static)\//i;

/** Rough char→token estimate for budget planning (code is denser than prose). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function isNoiseFile(filename: string): boolean {
  const base = filename.split("/").pop() || filename;
  if (SKIP_BASENAME.test(base)) return true;
  if (SKIP_EXTENSION.test(filename)) return true;
  if (SKIP_PATH.test(filename)) return true;
  return false;
}

/** Lower score = pack earlier. */
export function filePriority(filename: string): number {
  const base = filename.split("/").pop() || filename;
  if (isNoiseFile(filename)) return 100;
  if (
    /\.(test|spec)\./i.test(base) ||
    /(^|\/)(__tests__|tests?|specs?)\//i.test(filename)
  ) {
    return 40;
  }
  if (/\.(md|txt|rst)$/i.test(base) || /(^|\/)docs?\//i.test(filename)) {
    return 50;
  }
  if (/\.(json|ya?ml|toml|ini|env)$/i.test(base)) return 30;
  if (
    /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|c|cpp|h|hpp)$/i.test(
      base,
    )
  ) {
    return 10;
  }
  return 20;
}

const PATH_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|c|cpp|h|hpp|vue|svelte|json|ya?ml|toml|md|sql)$/i;

/**
 * Pull path-like citations out of prior roast text (backticks or bare paths).
 */
export function extractCitedPaths(text: string): string[] {
  if (!text?.trim()) return [];
  const found = new Set<string>();

  const backtick = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = backtick.exec(text)) !== null) {
    const candidate = m[1].trim().replace(/\\/g, "/");
    if (candidate.includes("/") && PATH_EXT.test(candidate)) {
      found.add(candidate.replace(/^\.\//, ""));
    } else if (PATH_EXT.test(candidate) && !candidate.includes(" ")) {
      // basename-only citation e.g. `orgs.service.ts`
      found.add(candidate);
    }
  }

  const bare =
    /(?:^|[\s*([<])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)/g;
  while ((m = bare.exec(text)) !== null) {
    const candidate = m[1].replace(/\\/g, "/").replace(/[),.;:]+$/, "");
    if (PATH_EXT.test(candidate)) found.add(candidate);
  }

  return [...found];
}

/** True if this changed file was cited in a prior roast. */
export function matchesPriorityPath(
  filename: string,
  priorityPaths: ReadonlySet<string>,
): boolean {
  if (priorityPaths.size === 0) return false;
  const norm = filename.replace(/\\/g, "/");
  const base = norm.split("/").pop() || norm;
  for (const raw of priorityPaths) {
    const p = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!p) continue;
    if (norm === p || norm.endsWith(`/${p}`) || p.endsWith(`/${norm}`)) {
      return true;
    }
    if (!p.includes("/") && base === p) return true;
  }
  return false;
}

/** True for lines a patch adds (excludes the `+++` file header). */
function isAddedLine(line: string): boolean {
  return line.startsWith("+") && !line.startsWith("+++");
}

/**
 * Split a patch into hunk blocks. Patches without `@@` headers (GitHub clips
 * very large patches) come back as one opaque block.
 */
export function splitPatchHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let buffer: string[] = [];
  let started = false;

  const flush = () => {
    if (!started || buffer.length === 0) return;
    hunks.push({
      text: buffer.join("\n"),
      added: buffer.filter(isAddedLine).length,
      index: hunks.length,
    });
    buffer = [];
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@ ")) {
      flush();
      started = true;
    }
    if (started) buffer.push(line);
  }
  flush();

  if (hunks.length > 0) return hunks;
  const lines = patch.split("\n");
  return [{ text: patch, added: lines.filter(isAddedLine).length, index: 0 }];
}

type HunkSelection = {
  text: string;
  hunksShown: number;
  hunksTotal: number;
  /** Hunk numbers (1-based) that made it into the pack. */
  shownNumbers: number[];
  clipped: boolean;
};

/**
 * Keep the highest-signal hunks inside `maxChars`. Added-code density wins:
 * new functions, transactions and validation live in added lines, and slicing
 * the tail of a patch dropped exactly those.
 */
export function selectPatchHunks(patch: string, maxChars: number): HunkSelection {
  const hunks = splitPatchHunks(patch);
  if (patch.length <= maxChars) {
    return {
      text: patch,
      hunksShown: hunks.length,
      hunksTotal: hunks.length,
      shownNumbers: hunks.map((h) => h.index + 1),
      clipped: false,
    };
  }

  const gap = (count: number) =>
    `… [${count} hunk${count === 1 ? "" : "s"} not shown]`;
  const ranked = [...hunks].sort(
    (a, b) => b.added - a.added || a.index - b.index,
  );
  const chosen = new Set<number>();
  let used = 0;

  for (const hunk of ranked) {
    const cost = hunk.text.length + 1;
    if (used + cost > maxChars && chosen.size > 0) continue;
    chosen.add(hunk.index);
    used += cost;
    if (used >= maxChars) break;
  }
  if (chosen.size === 0) chosen.add(ranked[0]!.index);

  const parts: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    if (!chosen.has(hunk.index)) continue;
    if (hunk.index > cursor) parts.push(gap(hunk.index - cursor));
    parts.push(hunk.text);
    cursor = hunk.index + 1;
  }
  if (cursor < hunks.length) parts.push(gap(hunks.length - cursor));

  let text = parts.join("\n");
  // A single hunk can still be larger than the whole per-file budget.
  if (text.length > maxChars) {
    text = `${text.slice(0, Math.max(0, maxChars - 20))}\n… [file truncated]\n`;
  }

  return {
    text,
    hunksShown: chosen.size,
    hunksTotal: hunks.length,
    shownNumbers: [...chosen].sort((a, b) => a - b).map((i) => i + 1),
    clipped: true,
  };
}

type FileBlock = {
  filename: string;
  block: string;
  shownChars: number;
  totalChars: number;
  hunksShown: number;
  hunksTotal: number;
  clipped: boolean;
};

function formatFileBlock(
  file: DiffFile,
  maxPerFileChars: number,
): FileBlock {
  if (!file.patch) {
    return {
      filename: file.filename,
      block: `--- ${file.filename} (${file.status})\n(binary or too large for GitHub patch API)\n`,
      shownChars: 0,
      totalChars: 0,
      hunksShown: 0,
      hunksTotal: 0,
      clipped: false,
    };
  }

  const selection = selectPatchHunks(file.patch, maxPerFileChars);
  const annotation = selection.clipped
    ? ` [partial: ${selection.hunksShown} of ${selection.hunksTotal} hunks]`
    : "";
  return {
    filename: file.filename,
    block: `--- ${file.filename} (${file.status})${annotation}\n${selection.text}\n`,
    shownChars: Math.min(selection.text.length, file.patch.length),
    totalChars: file.patch.length,
    hunksShown: selection.hunksShown,
    hunksTotal: selection.hunksTotal,
    clipped: selection.clipped,
  };
}

function buildInventory(
  omitted: Array<{ filename: string; reason: string }>,
  partial: PartialFile[],
): string {
  const sections: string[] = [];

  if (partial.length > 0) {
    sections.push(
      [
        "Partially shown files (hunks were dropped to fit the budget — code you cannot see here is NOT proof that it is missing):",
        ...partial
          .slice(0, 20)
          .map(
            (p) =>
              `- ${p.filename} (${p.hunksShown} of ${p.hunksTotal} hunks, ${p.shownChars} of ${p.totalChars} chars)`,
          ),
      ].join("\n"),
    );
  }

  if (omitted.length > 0) {
    const lines = omitted
      .slice(0, 40)
      .map((o) => `- ${o.filename} (${o.reason})`);
    if (omitted.length > 40) {
      lines.push(`- …and ${omitted.length - 40} more omitted files`);
    }
    sections.push(["Omitted from detailed review:", ...lines].join("\n"));
  }

  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

/**
 * Build a packed diff + body that fits within character budgets.
 * Files cited in a prior roast (priorityPaths) are packed first.
 */
export function packPullContext(
  files: DiffFile[],
  body: string,
  options: PackOptions,
  filesIncomplete = false,
  priorityPaths?: ReadonlySet<string>,
): PackedContext {
  const maxTotal = Math.max(2_000, options.maxTotalChars);
  const maxPerFile = Math.max(400, options.maxPerFileChars);
  const maxBody = Math.max(200, options.maxBodyChars);
  const boost = priorityPaths ?? new Set<string>();

  let packedBody = body?.trim() ? body.trim() : "(no description)";
  let truncated = filesIncomplete;
  if (packedBody.length > maxBody) {
    packedBody = `${packedBody.slice(0, maxBody - 20)}\n… [body truncated]`;
    truncated = true;
  }

  const omitted: Array<{ filename: string; reason: string }> = [];
  const partialFiles: PartialFile[] = [];
  const included = new Set<string>();
  const chunks: string[] = [];
  let used = 0;
  let shownPatchChars = 0;
  let totalPatchChars = 0;

  const ranked = files
    .map((file, index) => ({
      file,
      index,
      priority: matchesPriorityPath(file.filename, boost)
        ? 0
        : filePriority(file.filename),
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index);

  const recordCoverage = (block: FileBlock) => {
    used += block.block.length;
    shownPatchChars += block.shownChars;
    totalPatchChars += block.totalChars;
    if (block.clipped && block.totalChars > 0) {
      partialFiles.push({
        filename: block.filename,
        shownChars: block.shownChars,
        totalChars: block.totalChars,
        hunksShown: block.hunksShown,
        hunksTotal: block.hunksTotal,
      });
    }
  };

  for (const { file } of ranked) {
    if (isNoiseFile(file.filename)) {
      omitted.push({
        filename: file.filename,
        reason: "skipped noisy/generated file",
      });
      truncated = true;
      continue;
    }

    let block = formatFileBlock(file, maxPerFile);

    if (used + block.block.length > maxTotal) {
      const remaining = maxTotal - used;
      if (remaining < 400 || included.has(file.filename)) {
        omitted.push({ filename: file.filename, reason: "over total budget" });
        truncated = true;
        continue;
      }
      // Last file that fits: keep its best hunks instead of a mid-line slice.
      block = formatFileBlock(file, remaining - 80);
    }

    if (block.clipped) truncated = true;
    chunks.push(block.block);
    included.add(file.filename);
    recordCoverage(block);
  }

  // Any source file we never marked included/omitted (shouldn't happen) — belt and suspenders.
  for (const file of files) {
    if (included.has(file.filename)) continue;
    if (omitted.some((o) => o.filename === file.filename)) continue;
    omitted.push({ filename: file.filename, reason: "over total budget" });
    truncated = true;
  }

  if (filesIncomplete) {
    omitted.push({
      filename: "…",
      reason: "additional changed files not fetched (PR too large)",
    });
  }

  if (chunks.length === 0) {
    chunks.push(
      files.length === 0
        ? "(no file patches available)"
        : "(all changed files were skipped as noisy/generated or over budget — see omitted list)",
    );
    truncated = true;
  }

  return {
    body: packedBody,
    diff: `${chunks.join("\n")}${buildInventory(omitted, partialFiles)}`,
    truncated: truncated || omitted.length > 0 || partialFiles.length > 0,
    includedFiles: included.size,
    includedFilenames: [...included],
    totalFiles: files.length,
    omitted,
    partialFiles,
    shownPatchChars,
    totalPatchChars,
  };
}

/** Default packing budgets by provider (diff portion; leave room for system + metadata). */
export const PROVIDER_DIFF_BUDGETS = {
  /**
   * Gemini 3.6 Flash: ~1M context; free tier is RPM/TPM limited in AI Studio.
   * Cap for latency, not hard context.
   */
  gemini: { maxTotalChars: 48_000, maxPerFileChars: 6_000, maxBodyChars: 2_500 },
  /**
   * Groq free `openai/gpt-oss-20b`: 8K TPM (not per-request). Keep the first
   * attempt small so a shrink-retry is not required (retries burn the same minute).
   */
  groq: { maxTotalChars: 6_000, maxPerFileChars: 1_500, maxBodyChars: 800 },
  /**
   * Workers AI free plan: 10k Neurons/day. Moderate pack so failover still sees
   * key files without burning the daily neuron budget on one mega-prompt.
   */
  workersai: { maxTotalChars: 24_000, maxPerFileChars: 3_500, maxBodyChars: 1_500 },
} as const;

export type ProviderName = keyof typeof PROVIDER_DIFF_BUDGETS;
