/**
 * Pack PR file patches into a prompt-sized budget.
 *
 * Free-tier providers (especially Groq) reject oversized prompts, so we:
 * - drop noisy / generated files
 * - prefer source over lockfiles and assets
 * - cap each file and the total
 * - keep an inventory of what was omitted
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

export type PackedContext = {
  body: string;
  diff: string;
  truncated: boolean;
  includedFiles: number;
  /** Filenames that received a detailed pack block. */
  includedFilenames: string[];
  totalFiles: number;
  omitted: Array<{ filename: string; reason: string }>;
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

function truncatePatch(
  patch: string,
  maxChars: number,
): { text: string; clipped: boolean } {
  if (patch.length <= maxChars) return { text: patch, clipped: false };
  return {
    text: `${patch.slice(0, Math.max(0, maxChars - 20))}\n… [file truncated]\n`,
    clipped: true,
  };
}

function formatFileBlock(
  file: DiffFile,
  maxPerFileChars: number,
): { block: string; clipped: boolean } {
  const header = `--- ${file.filename} (${file.status})\n`;
  if (!file.patch) {
    return {
      block: `${header}(binary or too large for GitHub patch API)\n`,
      clipped: false,
    };
  }
  const { text, clipped } = truncatePatch(file.patch, maxPerFileChars);
  return { block: `${header}${text}\n`, clipped };
}

function buildInventory(
  omitted: Array<{ filename: string; reason: string }>,
): string {
  if (omitted.length === 0) return "";
  const lines = omitted
    .slice(0, 40)
    .map((o) => `- ${o.filename} (${o.reason})`)
    .join("\n");
  const extra =
    omitted.length > 40
      ? `\n- …and ${omitted.length - 40} more omitted files`
      : "";
  return `\n\nOmitted from detailed review:\n${lines}${extra}`;
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
  const included = new Set<string>();
  const chunks: string[] = [];
  let used = 0;

  const ranked = files
    .map((file, index) => ({
      file,
      index,
      priority: matchesPriorityPath(file.filename, boost)
        ? 0
        : filePriority(file.filename),
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index);

  for (const { file } of ranked) {
    if (isNoiseFile(file.filename)) {
      omitted.push({
        filename: file.filename,
        reason: "skipped noisy/generated file",
      });
      truncated = true;
      continue;
    }

    const { block, clipped } = formatFileBlock(file, maxPerFile);
    if (clipped) truncated = true;

    if (used + block.length > maxTotal) {
      const remaining = maxTotal - used;
      if (remaining > 240 && !included.has(file.filename)) {
        chunks.push(`${block.slice(0, remaining)}\n… [truncated]\n`);
        included.add(file.filename);
        used = maxTotal;
      } else {
        omitted.push({ filename: file.filename, reason: "over total budget" });
      }
      truncated = true;
      continue;
    }

    chunks.push(block);
    used += block.length;
    included.add(file.filename);
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
    diff: `${chunks.join("\n")}${buildInventory(omitted)}`,
    truncated: truncated || omitted.length > 0,
    includedFiles: included.size,
    includedFilenames: [...included],
    totalFiles: files.length,
    omitted,
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
   * Groq free `openai/gpt-oss-20b`: 8K TPM (not per-request). Stay under so
   * system + prior roast + max_tokens still fit in one minute's budget.
   */
  groq: { maxTotalChars: 10_000, maxPerFileChars: 2_000, maxBodyChars: 1_000 },
  /**
   * Workers AI free plan: 10k Neurons/day. Moderate pack so failover still sees
   * key files without burning the daily neuron budget on one mega-prompt.
   */
  workersai: { maxTotalChars: 32_000, maxPerFileChars: 4_000, maxBodyChars: 2_000 },
} as const;

export type ProviderName = keyof typeof PROVIDER_DIFF_BUDGETS;
