# Roast my PR

Self-hosted GitHub App that roasts pull requests when someone comments `/roastmypr`.

Runs on **Cloudflare Workers** (free tier) with free-tier LLMs: **Google Gemini** (primary), **Workers AI**, then optional **Groq** as last resort. An optional **paid OpenAI-compatible endpoint** can be put first in the chain for sharper reviews. No paid APIs required. Account-only install: your App only works on your account’s repos. Anyone else who wants the bot should clone this repo and deploy their own copy.

## How it works

1. You comment `/roastmypr` on a PR (first line of the comment).
2. GitHub sends an `issue_comment` webhook to your Worker.
3. The Worker verifies the signature, loads the PR diff, and reads the review state left by the previous roast (reviewed SHA + findings).
4. It calls the provider chain — an optional paid OpenAI-compatible endpoint first, then Gemini, Workers AI, Groq — falling through whenever a provider fails or returns nothing usable, and posts the roast. The footer carries fresh state, so the next roast knows what it already said.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a deep dive.

### Repeat roasts

The bot keeps memory of its own review in the comment footer (an invisible HTML comment), so re-running it after you push fixes does not re-raise what you already fixed:

- Each roast records the **reviewed commit SHA** plus its findings as `F1..Fn`.
- On the next run the Worker asks GitHub's compare API for **what changed since that SHA** and tells the model those changes are the author's fixes. The model must answer every finding `resolved`, `still present — "<quote>"`, or `unverifiable` (it is told to say "unverifiable" rather than repeat something it cannot see).
- Bullets that contradict that accounting — re-raising something the model itself marked resolved — are dropped before posting.
- Files are packed **by hunk**, not by truncating the tail of a patch, and clipped files are named to the model as partially shown.
- If a run covers only a fraction of the PR — most often on the thin Groq last-resort pack — the comment opens with a visible coverage banner instead of pretending it saw everything. After Gemini: `Partial review: only N of M changed files fitted the provider's budget (~P% of the diff text)`. After Workers AI or Groq: ``Partial review via fallback model (`groq`): only N of M changed files … Claims outside the packed slice are unverified.`` Runs where every file fitted but patch text was clipped are labelled too; PRs with fewer than 8 changed files are not.
- A model's scratchpad is never posted. Answers must carry the review structure, and formatting notes — `*Drafting the specific insults*:`, `PR Title:` / `Author:` echoes, `I'll focus on…` — are rejected so the next provider answers instead. Nothing from a rejected reply is written into review state, so prompt echoes can never become findings the next roast has to account for.

## Commands

Comment `/roastmypr` as the first line of a PR comment to get a full roast review (case-insensitive; surrounding whitespace allowed).

## Quick start (self-host)

### Prerequisites

- Node.js 20+
- A [Cloudflare](https://dash.cloudflare.com/sign-up) account (Workers AI uses your Worker’s `AI` binding — no extra API key)
- A GitHub account
- A [Google AI Studio](https://aistudio.google.com/apikey) API key (free tier)
- Optional: [Groq](https://console.groq.com/keys) API key for last-resort failover
- Optional: a paid OpenAI (or OpenAI-compatible) API key **and** model id, to review with a stronger model first

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
- `OPENAI_API_KEY` **and** `OPENAI_MODEL` (optional paid; set both or they are ignored)

Workers AI is enabled by the `[ai]` binding in `wrangler.toml` (no secret).

**Production:**

```bash
npx wrangler secret put APP_ID
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put PRIVATE_KEY
npx wrangler secret put GEMINI_API_KEY
# Optional Groq last-resort failover:
npx wrangler secret put GROQ_API_KEY
# Optional paid provider. The template ships no OPENAI_* values, so opt in with
# both halves — a key without a model is ignored:
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put OPENAI_MODEL
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
| `OPENAI_MODEL` | *(none)* | Required whenever `OPENAI_API_KEY` is set — there is no default (e.g. `gpt-5.6-terra`) |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Paid provider base URL; any OpenAI-shaped gateway works |
| `OPENAI_REASONING_EFFORT` | *(unset)* | Sent as `reasoning_effort` for reasoning models (`low`, `medium`, `high`); setting it also omits `temperature`, which those models reject |
| `OPENAI_MAX_TOKENS_FIELD` | `max_completion_tokens` | Token-cap field for the paid provider; use `max_tokens` for older models or `omit` |
| `DAILY_ROAST_LIMIT` | `20` | Soft per-installation daily cap |
| `MAX_DIFF_CHARS` | `48000` | Ceiling on packed diff size — raise it for the paid provider's 120k budget to take effect |

**Paid provider (optional).** Set **both** `OPENAI_API_KEY` (secret) and `OPENAI_MODEL` (var) to put a paid, OpenAI-shaped endpoint first in the chain. A key without a model is ignored with a warning in the Worker logs, and there is no default model: the shipped `wrangler.toml` carries every `OPENAI_*` value commented out (see the block under `[vars]`), so deploying this template as-is never sends a diff to a paid vendor. Paid use is always explicit. Any OpenAI-compatible gateway works via `OPENAI_BASE_URL`. The paid path sends `temperature: 0.9` like the free tiers and caps output with `max_completion_tokens` (use `OPENAI_MAX_TOKENS_FIELD` for older models); setting `OPENAI_REASONING_EFFORT` marks the model as a reasoner, so `temperature` is omitted for it. A gateway that refuses any field we added — `reasoning_effort`, the token cap, a non-default `temperature` — gets called again with a plainer body (finally just `model` + `messages`) before the paid provider is given up on. Every outbound call has a 30-second deadline, so a vendor that stops answering hands the roast to the next provider instead of holding the webhook open. The paid call logs the token usage the provider reports, so spend is visible in `wrangler tail`. Anything that fails — bad key, quota, or two oversized prompts — falls through to the free tiers.

Provider order: **OpenAI (paid, if configured) → Gemini → Workers AI → Groq**. Workers AI runs when the `AI` binding is present; Groq is skipped if its API key is unset. Groq is last because its free-tier pack is tiny and weak models invent claims on thin slices. Workers AI reasoning families (Gemma, GLM, Qwen) are called with `thinking: { type: "disabled" }` — retried once without it if a model rejects the control — so the plan stays out of the answer, and any reply that still reads as planning or lacks the roast structure is discarded instead of posted.

Diffs are **packed per provider**: noisy files (lockfiles, images, `dist/`, etc.) are skipped, source is prioritized (within a tier, deleted files, renames, and high-signal paths such as `package.json`, `env.*`/`schema.*`, and controllers come before same-tier touches), and each provider gets a budget that fits its free-tier limits. Within a file the packer keeps the **added-code-dense hunks** (the ones where fixes live) and marks the file `[partial: 3 of 8 hunks]`, so a 12 KB file no longer loses its last functions to a tail truncation. If a provider rejects the prompt as too large — or, on Gemini and Workers AI, returns an empty completion — the Worker shrinks the pack 50% and retries once. Groq skips the empty-completion retry so a second call does not blow its 8K TPM minute. The paid provider gets the biggest budget (120,000 chars of diff), but `MAX_DIFF_CHARS` is still the ceiling — raise it (e.g. to `120000`) if you want the paid run to use that headroom. The "changes since your last review" diff is carved out of the same budget, so review memory never inflates the prompt.

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

- With a paid provider configured, PR diffs go to **your paid vendor first** (OpenAI, or whatever `OPENAI_BASE_URL` points at). That vendor's data policy applies and you pay per token.
- Otherwise — and whenever the paid call fails — diffs go to Gemini, and may also reach Groq and/or Workers AI. Check each provider’s free-tier terms (prompts may be used to improve products).
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
  diffPack.ts        Noise filtering, priority ranking, hunk packing, per-provider budgets
  pathFilter.ts      Path filter, evidence/intent gates, F1 accounting, hedge strip
  roast.ts           LLM client (OpenAI → Gemini → Workers AI → Groq)
  responseText.ts    Normalize / extract usable model completions
  prompts.ts         Roast personality, review state, coverage warnings
  rateLimit.ts       KV daily caps
  types.ts           Env, command, finding and review-state types
  *.test.ts          Node test-runner suites (npm test)
docs/
  ARCHITECTURE.md
  GITHUB_APP_SETUP.md
```

## Checks

```bash
npm run typecheck   # tsc --noEmit
npm test            # Node test runner over src/*.test.ts
```

## License

MIT
