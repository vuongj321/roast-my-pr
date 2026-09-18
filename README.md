# Roast my PR

Self-hosted GitHub App that roasts pull requests when someone comments `/roastmypr`.

Runs on **Cloudflare Workers** (free tier) with free-tier LLMs: **Google Gemini** (primary), **Workers AI**, then optional **Groq** as last resort. No paid APIs required. Account-only install: your App only works on your account’s repos. Anyone else who wants the bot should clone this repo and deploy their own copy.

## How it works

1. You comment `/roastmypr` on a PR (first line of the comment).
2. GitHub sends an `issue_comment` webhook to your Worker.
3. The Worker verifies the signature, loads the PR diff, and reads the review state left by the previous roast (reviewed SHA + findings).
4. It calls Gemini (falling back to Workers AI then Groq on capacity/quota errors) and posts the roast. The footer carries fresh state, so the next roast knows what it already said.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a deep dive.

### Repeat roasts

The bot keeps memory of its own review in the comment footer (an invisible HTML comment), so re-running it after you push fixes does not re-raise what you already fixed:

- Each roast records the **reviewed commit SHA** plus its findings as `F1..Fn`.
- On the next run the Worker asks GitHub's compare API for **what changed since that SHA** and tells the model those changes are the author's fixes. The model must answer every finding `resolved`, `still present — "<quote>"`, or `unverifiable` (it is told to say "unverifiable" rather than repeat something it cannot see).
- Bullets that contradict that accounting — re-raising something the model itself marked resolved — are dropped before posting.
- Files are packed **by hunk**, not by truncating the tail of a patch, and clipped files are named to the model as partially shown.
- If a run only covers a fraction of the PR (typical on the thin Groq last-resort pack), the comment starts with `Partial review: only N of M changed files…` instead of pretending it saw everything.

## Commands

Comment `/roastmypr` as the first line of a PR comment to get a full roast review (case-insensitive; surrounding whitespace allowed).

## Quick start (self-host)

### Prerequisites

- Node.js 20+
- A [Cloudflare](https://dash.cloudflare.com/sign-up) account (Workers AI uses your Worker’s `AI` binding — no extra API key)
- A GitHub account
- A [Google AI Studio](https://aistudio.google.com/apikey) API key (free tier)
- Optional: [Groq](https://console.groq.com/keys) API key for last-resort failover

### 1. Clone and install

```bash
git clone <this-repo-url>
cd roast-my-pr
npm install
```

### 2. Create the GitHub App

Follow **[docs/GITHUB_APP_SETUP.md](docs/GITHUB_APP_SETUP.md)** (account-only install, permissions, PKCS#8 key, smee for local webhooks).

### 3. Create a KV namespace (rate limits)

```bash
npx wrangler login
npx wrangler kv namespace create RATE_LIMIT
npx wrangler kv namespace create RATE_LIMIT --preview
```

Put the returned ids into [`wrangler.toml`](wrangler.toml) under `[[kv_namespaces]]`.

### 4. Configure secrets

**Local** — copy [`.dev.vars.example`](.dev.vars.example) to `.dev.vars` and fill in:

- `APP_ID`
- `WEBHOOK_SECRET`
- `PRIVATE_KEY` (PKCS#8 PEM)
- `GEMINI_API_KEY`
- `GROQ_API_KEY` (optional)

Workers AI is enabled by the `[ai]` binding in `wrangler.toml` (no secret).

**Production:**

```bash
npx wrangler secret put APP_ID
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put PRIVATE_KEY
npx wrangler secret put GEMINI_API_KEY
# Optional Groq last-resort failover:
npx wrangler secret put GROQ_API_KEY
```

If you previously used OpenRouter, remove the stale secret:

```bash
npx wrangler secret delete OPENROUTER_API_KEY
```

Optional vars in `wrangler.toml` (not secret):

| Variable | Default | Meaning |
| --- | --- | --- |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Primary model id (AI Studio free tier) |
| `GROQ_MODEL` | `openai/gpt-oss-20b` | Groq last-resort model |
| `WORKERS_AI_MODEL` | `@cf/google/gemma-4-26b-a4b-it` | Workers AI fallback model |
| `DAILY_ROAST_LIMIT` | `20` | Soft per-installation daily cap |
| `MAX_DIFF_CHARS` | `48000` | Ceiling on packed diff size (per-provider budgets are lower for Groq) |

Failover order: **Gemini → Workers AI → Groq**. Workers AI runs when the `AI` binding is present; Groq is skipped if its API key is unset. Groq is last because its free-tier pack is tiny and weak models invent claims on thin slices.

Diffs are **packed per provider**: noisy files (lockfiles, images, `dist/`, etc.) are skipped, source is prioritized, and each provider gets a budget that fits its free-tier limits. Within a file the packer keeps the **added-code-dense hunks** (the ones where fixes live) and marks the file `[partial: 3 of 8 hunks]`, so a 12 KB file no longer loses its last functions to a tail truncation. If a provider rejects the prompt as too large or returns an empty completion, the Worker shrinks the pack and retries once. The "changes since your last review" diff is carved out of the same budget, so review memory never inflates the prompt.

### 5. Run locally

```bash
npm run dev
```

Point the App webhook (via smee) at your local Worker as described in the setup doc. Install the App on a test repo, open a PR, comment `/roastmypr`.

### 6. Deploy

```bash
npm run deploy
```

Set the GitHub App **Webhook URL** to:

`https://<your-worker-name>.<your-subdomain>.workers.dev/api/github/webhooks`

Send a **ping** from the App settings to confirm delivery.

## Privacy / free-tier notes

- PR diffs are sent to Gemini first; on failover they may also go to Groq and/or Workers AI. Check each provider’s free-tier terms (prompts may be used to improve products).
- Workers AI free plan includes **10,000 Neurons/day** (resets UTC midnight).
- Quotas are yours alone (self-hosted). Soft daily caps in KV reduce accidental burn.
- Webhook signature verification is mandatory; do not disable it.

## Project layout

```
src/
  index.ts           Worker entry + signature verify
  app.ts             issue_comment orchestration
  command.ts         /roastmypr parsing
  github.ts          App auth, PR context fetch, comments
  diffPack.ts        Noise filtering + hunk-level packing + per-provider budgets
  pathFilter.ts      Path filter, evidence/intent gates, F1 accounting, hedge strip
  roast.ts           LLM client (Gemini → Workers AI → Groq)
  responseText.ts    Normalize / extract usable model completions
  prompts.ts         Roast personality, review state, coverage warnings
  rateLimit.ts       KV daily caps
  types.ts           Env, command, finding and review-state types
docs/
  ARCHITECTURE.md
  GITHUB_APP_SETUP.md
```

## License

MIT
