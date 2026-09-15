# Roast my PR — System Architecture

This document explains how Roast my PR works end to end: what each piece is, how they talk to each other, and why the design looks this way. It assumes no prior experience building GitHub bots.

## 1. What the product is

Roast my PR is an **on-demand AI PR review bot**. Someone comments `/roastmypr` on a pull request; the bot reads the PR diff, asks a free-tier language model to produce a witty but useful roast, and posts that roast back as a PR comment.

It is **not**:

- A GitHub Marketplace multi-tenant service other people install onto *your* hosting
- An always-on virtual machine you babysit
- A paid OpenAI/Anthropic integration

It **is**:

- A **self-hosted GitHub App** (account-only install)
- Running on a **Cloudflare Worker** (serverless HTTP handler)
- Powered by **free-tier LLMs** (Gemini primary, optional Groq / OpenRouter failover)
- Meant to be **cloned** by anyone who wants their own copy, with their own App, Worker, and API key

## 2. High-level system diagram

```mermaid
flowchart LR
  subgraph github [GitHub]
    User[User comments /roastmypr]
    AppReg[GitHub App registration]
    Repos[Installed repositories]
  end

  subgraph cloudflare [Your Cloudflare account]
    Worker[Cloudflare Worker]
    KV[KV rate-limit store optional]
    Secrets[Secrets APP_ID PRIVATE_KEY WEBHOOK_SECRET GEMINI_API_KEY optional GROQ OPENROUTER]
  end

  subgraph models [Free-tier LLMs]
    Gemini[Gemini primary]
    Groq[Groq fallback]
    OpenRouter[OpenRouter fallback]
  end

  User --> Repos
  Repos -->|issue_comment webhook| Worker
  AppReg -.->|identity and permissions| Worker
  Secrets --> Worker
  Worker -->|verify signature auth Octokit| Repos
  Worker --> KV
  Worker -->|diff plus roast prompt| Gemini
  Gemini -.->|on capacity or quota| Groq
  Groq -.->|on capacity or quota| OpenRouter
  Gemini -->|roast text| Worker
  Groq -->|roast text| Worker
  OpenRouter -->|roast text| Worker
  Worker -->|post PR comment| Repos
```

**One sentence:** GitHub notifies your Worker; the Worker proves the request is real, authenticates as your App, loads the PR diff, calls Gemini (with Groq/OpenRouter failover), and writes the roast back to the PR.

## 3. The four building blocks

### 3.1 GitHub App (identity + permissions + events)

A GitHub App is an integration you register once under your GitHub account. It is not a user you log into. It defines:

| Concern | What it means here |
| --- | --- |
| **Identity** | App ID + private key prove “this request is from Roast my PR” |
| **Permissions** | What the bot is allowed to read/write (contents, PRs, issues) |
| **Events** | Which webhooks GitHub sends (here: `issue_comment`) |
| **Install scope** | **Only on this account** — only repos under the owning account |
| **Installation** | You pick all repos or a subset; the bot only works there |

Important distinction:

- **App registration** = the blueprint (permissions, webhook URL, secret)
- **Installation** = turning that blueprint on for specific repositories

Without an installation on a repo, commenting `/roastmypr` does nothing useful—GitHub will not grant the App access to that repo’s data.

### 3.2 Cloudflare Worker (the runtime)

A Worker is a small TypeScript program that runs when an HTTPS request hits your Worker URL. There is no long-lived server process. Each webhook is roughly: receive request → run handler → return response.

Responsibilities of the Worker:

1. Accept `POST` webhooks at something like `/api/github/webhooks`
2. Verify GitHub’s webhook signature
3. Parse the event and decide if it is a `/roastmypr` command on a PR
4. Authenticate to the GitHub API as the App installation
5. Fetch PR metadata and the diff
6. Optionally check a daily rate limit in KV
7. Call an LLM with the roast prompt (Gemini → Groq → OpenRouter)
8. Post the roast comment

**Wrangler** is Cloudflare’s CLI used to develop (`wrangler dev`), set secrets, and deploy (`wrangler deploy`).

### 3.3 Free-tier LLMs (the brain)

Google AI Studio issues a free-tier Gemini API key (required). Optional Groq and OpenRouter keys act as failover when Gemini hits capacity, rate limits, or other retryable errors.

The Worker sends:

- A **system prompt** (roast personality, rules, output shape)
- A **user payload** (PR title, body, **packed** file patches)

Packing is **provider-specific**. Gemini can take a larger diff than Groq’s free-tier TPM cap (~8k tokens/request). On failover we rebuild a smaller pack instead of resending the Gemini-sized prompt. Noisy files (lockfiles, images, `dist/`, etc.) are skipped and listed as omitted so the model still knows they changed.

The first successful provider returns text; the Worker posts that text to GitHub. No model runs inside Cloudflare—Cloudflare only orchestrates.

### 3.4 Optional Cloudflare KV (quota guardrail)

KV is a simple key-value store. We can use it to track something like `installationId:YYYY-MM-DD → roast count` and refuse or defer when a soft daily cap is hit. That protects *your* free-tier limits from accidental spam on your own repos. It is not multi-tenant isolation (this architecture is account-only / self-hosted).

## 4. Request lifecycle (happy path)

```mermaid
sequenceDiagram
  participant Human
  participant GitHub
  participant Worker as CloudflareWorker
  participant KV as CloudflareKV
  participant LLM as FreeTierLLM

  Human->>GitHub: Comment /roastmypr on a PR
  GitHub->>Worker: POST issue_comment webhook plus X-Hub-Signature-256
  Worker->>Worker: Verify HMAC signature with WEBHOOK_SECRET
  Worker->>Worker: Ignore if not PR, not /roastmypr, or author is a bot
  Worker->>KV: Check and increment daily roast count
  alt Over daily cap
    Worker->>GitHub: Comment free tier limit message
  else Under cap
    Worker->>GitHub: Fetch PR files and patches as installation
    Worker->>Worker: Pack diff for provider budget (skip noise)
    Worker->>LLM: Gemini then Groq then OpenRouter (repack each time)
    LLM-->>Worker: Roast markdown
    Worker->>GitHub: Post roast comment on PR
  end
  Worker-->>GitHub: HTTP 200
```

### Step-by-step

1. **Trigger** — A human comments on a pull request. The first line must be exactly `/roastmypr` (no aliases or help subcommand).

2. **Webhook delivery** — GitHub POSTs a JSON payload to the App’s webhook URL. Headers include the event name and `X-Hub-Signature-256`.

3. **Signature verification** — The Worker recomputes an HMAC-SHA256 of the raw body using `WEBHOOK_SECRET` and compares it to the header. Mismatch → `401` and stop. This stops strangers from forging events against your public Worker URL.

4. **Filtering** — Drop events that are not PR conversation comments, were authored by bots, or do not start with `/roastmypr`. Respond `200` quickly for ignored events so GitHub does not retry forever.

5. **GitHub App authentication** — The Worker cannot use a personal password. It:
   - Builds a short-lived **JWT** signed with the App `PRIVATE_KEY` and `APP_ID`
   - Exchanges that JWT for an **installation access token** for the installation that owns the repo
   - Uses that token (via Octokit) for API calls

6. **Rate limit** — Check and increment the daily roast counter in KV. If over the cap, post a limit message and stop.

7. **Context load** — Fetch PR title, body, changed files, and patches. Diffs are not dumped raw into one megaprompt; they are packed later per provider.

8. **Roast generation** — For each provider (Gemini → Groq → OpenRouter): pack the file list into that provider’s character budget, call the API, and on “request too large” shrink 50% and retry once. Skip providers without keys. Only when every configured provider fails with quota-like errors do we post a friendly “free tier is napping” comment.

9. **Final comment** — Post one markdown comment on the PR (v1 does not create inline review threads on specific lines).

10. **HTTP response** — Return success to GitHub. Webhook handlers should acknowledge promptly; heavy work still happens in the same invocation for MVP (Workers have CPU/time limits—keep prompts and diffs bounded).

## 5. Code layout (intended modules)

```
roast-my-pr/
  package.json
  wrangler.toml              # Worker name, KV bindings, compatibility flags
  src/
    index.ts                 # HTTP entry: route + signature verify + dispatch
    app.ts                   # issue_comment handling and /roastmypr routing
    github.ts                # App JWT, installation Octokit, PR context, comments
    diffPack.ts              # Noise filtering + per-provider diff budgets
    roast.ts                 # LLM client with Gemini → Groq → OpenRouter failover
    prompts.ts               # Roast personality and output format
    rateLimit.ts             # Optional KV daily caps
  docs/
    ARCHITECTURE.md          # This file
  README.md                  # Self-host setup guide
```

| Module | Responsibility |
| --- | --- |
| `index.ts` | Cloudflare `fetch` handler; webhook path; signature check; JSON parse |
| `app.ts` | Business rules: is this `/roastmypr`? orchestrate rate limit, roast, and reply |
| `github.ts` | All GitHub API interaction through Octokit |
| `diffPack.ts` | Skip noisy files, prioritize source, pack patches to a budget |
| `roast.ts` | Multi-provider LLM request/response, per-provider packing, failover |
| `prompts.ts` | Prompt text kept separate so tone can be tuned without touching I/O |
| `rateLimit.ts` | Read/increment KV counters |

**Octokit** is the TypeScript client for GitHub’s REST API. We use it directly (plus app-auth helpers) instead of the full **Probot** framework, because Probot assumes a more traditional Node server while Workers use a `fetch` handler model.

## 6. Security model

### 6.1 Webhook authenticity

- Shared secret configured in the GitHub App and in Cloudflare (`WEBHOOK_SECRET`)
- Every webhook must pass `X-Hub-Signature-256` verification before any side effect

### 6.2 GitHub authorization

- Least privilege permissions:
  - **Contents:** Read (needed for file/patch context as applicable)
  - **Pull requests:** Read
  - **Issues:** Read & write (PR comments use the Issues API)
  - **Metadata:** Read
- Installation tokens are short-lived and scoped to the installation
- Account-only install prevents strangers from attaching *your* App to *their* repos

### 6.3 Secrets handling

Secrets live in Cloudflare Worker secrets (or local `.dev.vars` for development), never in git:

- `APP_ID`
- `PRIVATE_KEY` (PKCS#8 PEM for Web Crypto on Workers)
- `WEBHOOK_SECRET`
- `GEMINI_API_KEY`
- `GROQ_API_KEY` (optional failover)
- `OPENROUTER_API_KEY` (optional failover)

### 6.4 Trust and privacy

The Worker receives PR diffs for repos where the App is installed. For a self-hosted, account-only bot, that means **your** repos and **your** API keys. Diffs go to Gemini first; on failover they may also be sent to Groq and/or OpenRouter. Free-tier providers may use prompts/responses to improve products—document that for operators of a self-hosted copy.

## 7. Local development vs production

### Production

```mermaid
flowchart LR
  GitHub -->|HTTPS webhook| WorkerURL["worker.workers.dev"]
  WorkerURL --> LLM[Gemini Groq OpenRouter]
```

Webhook URL on the GitHub App points at the deployed Worker.

### Local development

GitHub cannot reach `localhost` directly. A relay such as **smee.io** provides a public URL that forwards events to `wrangler dev` on your machine:

```mermaid
flowchart LR
  GitHub -->|webhook| Smee[smee.io public URL]
  Smee -->|forward| Local["wrangler dev on localhost"]
  Local --> LLM[Gemini Groq OpenRouter]
```

Flow for a developer:

1. `wrangler dev` runs the Worker locally
2. Smee (or similar) tunnels GitHub → local
3. Temporarily set the App webhook URL to the smee URL
4. Comment `/roastmypr` on a test PR in an installed repo
5. After deploy, point the webhook back at the production Worker URL

## 8. Distribution and tenancy

Roast my PR is **single-operator self-host**:

| Actor | What they run | Whose quotas |
| --- | --- | --- |
| You | Your App + Worker + LLM keys | Yours |
| Someone else who wants the bot | Clone/fork → their App + Worker + LLM keys | Theirs |

They do **not** install your App onto their account when the App is **Only on this account**. Cloning the software is how the bot spreads—not a shared SaaS install button.

## 9. Failure modes and expected behavior

| Situation | Expected bot behavior |
| --- | --- |
| Bad webhook signature | `401`; no comments |
| Comment on a non-PR issue | Ignore |
| Bot-authored comment | Ignore (prevent loops) |
| Command without install / missing permission | Error comment or logged failure; no crash loop |
| Diff too large | Truncate; note in roast that review is partial |
| All configured LLMs rate-limited / quota | User-visible “try later” comment |
| Optional KV daily cap exceeded | User-visible limit comment; no LLM call |

## 10. Explicit non-goals (v1)

- Public “Any account” installs sharing one set of LLM keys
- Inline file/line review comments
- Auto-roast on every `pull_request` opened
- Bring-your-own-key dashboards
- GitHub Marketplace listing
- Paid-only model fallbacks (Groq/OpenRouter free tiers only)

## 11. Mental model summary

Think of the system as three doors and one brain:

1. **GitHub App door** — Who is allowed to act in which repos, and which events are sent  
2. **Worker door** — Public HTTPS endpoint that only trusts signed GitHub traffic  
3. **LLM brain** — Turns diff + roast instructions into the comment text (Gemini, with Groq/OpenRouter failover)  
4. **KV latch (optional)** — Stops you from accidentally exhausting free-tier quota  

The slash command is only a **user-facing trigger**. All real work is webhook → verify → auth → diff → model → comment.

## Related docs

- [GITHUB_APP_SETUP.md](./GITHUB_APP_SETUP.md) — create the App, secrets, smee, install on repos
- [../README.md](../README.md) — clone, KV, deploy, commands
