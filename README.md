# Roast my PR

Self-hosted GitHub App that roasts pull requests when someone comments `/roastmypr`.

Runs on **Cloudflare Workers** (free tier) and **Google Gemini** (AI Studio free tier). No paid APIs required. Account-only install: your App only works on your account’s repos. Anyone else who wants the bot should clone this repo and deploy their own copy.

## How it works

1. You comment `/roastmypr` on a PR (first line of the comment).
2. GitHub sends an `issue_comment` webhook to your Worker.
3. The Worker verifies the signature, loads the PR diff, calls Gemini with a roast prompt, and posts the result.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a deep dive.

## Commands

| Comment (first line) | Effect |
| --- | --- |
| `/roastmypr` | Full roast review |
| `/roast` | Same |
| `/roast my pr` | Same |
| `/roastmypr help` | Usage text |

## Quick start (self-host)

### Prerequisites

- Node.js 20+
- A [Cloudflare](https://dash.cloudflare.com/sign-up) account
- A GitHub account
- A [Google AI Studio](https://aistudio.google.com/apikey) API key (free tier)

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

**Production:**

```bash
npx wrangler secret put APP_ID
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put PRIVATE_KEY
npx wrangler secret put GEMINI_API_KEY
```

Optional vars in `wrangler.toml` (not secret):

| Variable | Default | Meaning |
| --- | --- | --- |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Model id with free-tier access in your AI Studio project |
| `DAILY_ROAST_LIMIT` | `20` | Soft per-installation daily cap |
| `MAX_DIFF_CHARS` | `80000` | Max diff characters sent to Gemini |

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

- PR diffs are sent to Google Gemini. Free-tier Gemini usage may be used by Google to improve products—check Google’s current terms.
- Quotas are yours alone (self-hosted). Soft daily caps in KV reduce accidental burn.
- Webhook signature verification is mandatory; do not disable it.

## Project layout

```
src/
  index.ts       Worker entry + signature verify
  app.ts         issue_comment orchestration
  command.ts     /roastmypr parsing
  github.ts      App auth, diff fetch, comments
  roast.ts       Gemini client
  prompts.ts     Roast personality
  rateLimit.ts   KV daily caps
docs/
  ARCHITECTURE.md
  GITHUB_APP_SETUP.md
```

## License

MIT
