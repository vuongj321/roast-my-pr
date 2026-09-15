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
