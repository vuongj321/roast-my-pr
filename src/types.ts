export interface Env {
  APP_ID: string;
  PRIVATE_KEY: string;
  WEBHOOK_SECRET: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
  GROQ_API_KEY?: string;
  GROQ_MODEL: string;
  /** Workers AI binding from wrangler `[ai]`; present when configured. */
  AI?: Ai;
  WORKERS_AI_MODEL?: string;
  DAILY_ROAST_LIMIT: string;
  MAX_DIFF_CHARS: string;
  RATE_LIMIT: KVNamespace;
}

export interface RoastCommand {
  kind: "roast";
  raw: string;
}

/**
 * A single finding from a prior roast, carried forward as review state so the
 * next roast can account for it instead of re-deriving it from prose.
 */
export type PriorFinding = {
  id: string;
  /** Cited file path, when the finding names one. */
  path?: string;
  /** Short prose summary of what was flagged. */
  text: string;
};

/**
 * Machine-readable review state embedded in a posted roast footer (invisible
 * HTML comment). Populated so the next run can ask GitHub what changed since
 * the reviewed SHA.
 */
export type RoastState = {
  v: 1;
  /** Head commit SHA that was reviewed when this state was written. */
  sha?: string;
  findings: PriorFinding[];
};

/** How much of the PR the model actually saw for the run that produced a roast. */
export type PackCoverage = {
  includedFiles: number;
  totalFiles: number;
  /** Patch characters shown to the model. */
  shownChars: number;
  /** Patch characters in all reviewable files. */
  totalChars: number;
};

/** What the model reports about a prior finding. */
export type FindingStatus = "resolved" | "stillPresent" | "unverifiable";
