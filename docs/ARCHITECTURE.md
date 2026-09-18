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
- Powered by **free-tier LLMs** (Gemini primary, Workers AI, then optional Groq last)
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
    KV[KV rate-limit store]
    AIBind[Workers AI binding]
    Secrets[Secrets APP_ID PRIVATE_KEY WEBHOOK_SECRET GEMINI_API_KEY optional GROQ]
  end

  subgraph models [Free-tier LLMs]
    Gemini[Gemini primary]
    Groq[Groq last resort]
    WorkersAI[Workers AI fallback]
  end

  User --> Repos
  Repos -->|issue_comment webhook| Worker
  AppReg -.->|identity and permissions| Worker
  Secrets --> Worker
  AIBind --> Worker
  Worker -->|verify signature auth Octokit| Repos
  Worker --> KV
  Worker -->|diff plus roast prompt| Gemini
  Gemini -.->|on capacity or quota| WorkersAI
  WorkersAI -.->|on capacity or quota| Groq
  Gemini -->|roast text| Worker
  WorkersAI -->|roast text| Worker
  Groq -->|roast text| Worker
  Worker -->|post PR comment| Repos
```

**One sentence:** GitHub notifies your Worker; the Worker proves the request is real, authenticates as your App, loads the PR diff, calls Gemini (with Workers AI / Groq failover), and writes the roast back to the PR.

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
6. Check a daily rate limit in KV
7. Call an LLM with the roast prompt (Gemini → Workers AI → Groq)
8. Post the roast comment

**Wrangler** is Cloudflare’s CLI used to develop (`wrangler dev`), set secrets, and deploy (`wrangler deploy`).

### 3.3 Free-tier LLMs (the brain)

Google AI Studio issues a free-tier Gemini API key (required). **Workers AI** (via the Worker `AI` binding, no API key) is the first failover when Gemini hits capacity. Optional **Groq** is last resort: its free-tier pack is tiny (~6k chars) and weak models invent claims on thin slices. Workers AI free plan includes **10,000 Neurons/day**.

The Worker sends:

- A **system prompt** (roast personality, rules, output shape)
- A **user payload** (PR title, body, **packed** file patches)

Packing is **provider-specific**. Gemini can take a larger diff; Workers AI uses a moderate pack to preserve the daily neuron budget; Groq’s free-tier **8K TPM** forces the tightest pack and is tried last. On failover we rebuild a pack for that provider instead of resending the Gemini-sized prompt. Noisy files (lockfiles, images, `dist/`, etc.) are skipped and listed as omitted so the model still knows they changed. Paths cited in a prior roast are packed first. After the model replies, bullets that cite file paths **not** in the packed set are stripped, absolute claims without a quote from the packed diff are dropped, and Fix-it bullets that undo stated commit constraints are removed.

The first successful provider returns text; the Worker posts that text to GitHub. Gemini and Groq are external HTTP APIs; Workers AI runs through Cloudflare’s `env.AI` binding.

### 3.4 Cloudflare KV (quota guardrail)

KV is a simple key-value store. The Worker binds a `RATE_LIMIT` namespace and tracks `roast:{installationId}:{YYYY-MM-DD} → roast count`, refusing new roasts when the soft daily cap (`DAILY_ROAST_LIMIT`) is hit. That protects *your* free-tier limits from accidental spam on your own repos. It is not multi-tenant isolation (this architecture is account-only / self-hosted).

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
    Worker->>GitHub: Fetch latest prior roast comment with its review state
    Worker->>GitHub: If state SHA is older, fetch the compare delta
    Worker->>Worker: Pack diff by hunk (boost prior-cited paths; provider budget)
    Worker->>LLM: Gemini then Workers AI then Groq (findings + delta + diff)
    LLM-->>Worker: Roast markdown plus F1/F2 accounting lines
    Worker->>Worker: Drop unpacked-path bullets and self-contradicting repeats
    Worker->>GitHub: Post roast comment whose footer carries the new review state
  end
  Worker-->>GitHub: HTTP 200
```

### Step-by-step

1. **Trigger** — A human comments on a pull request. The first line must be `/roastmypr` alone (case-insensitive; surrounding whitespace allowed; no aliases or help subcommand).

2. **Webhook delivery** — GitHub POSTs a JSON payload to the App’s webhook URL. Headers include the event name and `X-Hub-Signature-256`.

3. **Signature verification** — The Worker recomputes an HMAC-SHA256 of the raw body using `WEBHOOK_SECRET` and compares it to the header. Mismatch → `401` and stop. This stops strangers from forging events against your public Worker URL.

4. **Filtering** — Drop events that are not PR conversation comments, were authored by bots, or whose first line is not `/roastmypr` alone. Respond `200` quickly for ignored events so GitHub does not retry forever.

5. **GitHub App authentication** — The Worker cannot use a personal password. It:
   - Builds a short-lived **JWT** signed with the App `PRIVATE_KEY` and `APP_ID`
   - Exchanges that JWT for an **installation access token** for the installation that owns the repo
   - Uses that token (via Octokit) for API calls

6. **Rate limit** — Check and increment the daily roast counter in KV. If over the cap, post a limit message and stop.

7. **Context load** — Fetch PR title, body, changed files, patches, the head SHA, and the PR's commit subjects (first lines, capped at 12). The subjects are the stated intent the model must treat as a deliberate tradeoff rather than a defect. Then load the latest prior Roast my PR comment (footer-marked) and read the machine-readable **review state** hidden in its footer: the SHA that was reviewed plus addressable findings (`F1`, `F2`, …). When that SHA differs from the current head, ask the compare API for what was pushed since — that delta is the only input which actually distinguishes "still broken" from "not shown to you". Roasts posted before review state existed carry none, so findings are derived from their bullets instead. Paths cited there are prioritized when packing so re-roasts can verify old findings. Diffs are not dumped raw into one megaprompt; they are packed later per provider.

8. **Roast generation** — For each provider (Gemini → Workers AI → Groq): pack the file list into that provider’s character budget, call the API/binding, and on “request too large” (or empty completion for non-Groq providers) shrink 50% and retry once. Groq requests set `include_reasoning: false` / `reasoning_effort: low` so answers land in `content`. Response parsing prefers `content`/`response`; `reasoning` is only accepted when it looks like a finished roast. What the prompt contains matters as much as the budget:
   - **Files are packed by hunk, not by tail.** A file whose patch exceeds the per-file cap keeps its *added-code-dense* hunks and drops the rest, with `[partial: 3 of 8 hunks]` on the header and `… [n hunks not shown]` gap markers. Truncating from the top of a patch is what hid transaction wrappers and validation written at the bottom of a 12 KB file.
   - **Partial coverage is stated, not implied.** Every clipped file is listed under “Partially shown files”, and the system prompt forbids claiming code is missing when it may simply be outside what was shown.
   - **The review delta is carved out of the same budget** (30%), so adding a delta never pushes a free-tier prompt past its limit.
   - **Prior findings must be accounted for**: the model emits one `- F1 resolved` / `- F2 still present — "<quote>"` / `- F3 unverifiable` line per finding before the roast, and is told never to re-raise something it marked resolved.
9. **Post-processing** — Strip the `F1/F2` accounting block, drop bullets that cite file paths not in the packed set, then drop bullets that contradict the accounting by re-raising a resolution the model itself declared. If the run saw less than half the changed files, **or** the pack clipped patch text, prepend a visible coverage banner: after Gemini `Partial review: only N of M changed files fitted the provider's budget (~P% of the diff text)…`, after Workers AI / Groq the louder ``Partial review via fallback model (`groq`): … Claims outside the packed slice are unverified.`` PRs with fewer than 8 changed files skip the banner.

10. **Final comment** — Post one markdown comment on the PR (v1 does not create inline review threads on specific lines). Its footer carries the reviewed SHA plus the findings parsed from this roast, so the *next* run has state instead of prose to reconcile against.

11. **HTTP response** — Return success to GitHub. Webhook handlers should acknowledge promptly; heavy work still happens in the same invocation for MVP (Workers have CPU/time limits—keep prompts and diffs bounded).

## 5. Code layout (intended modules)

```
roast-my-pr/
  package.json
  wrangler.toml              # Worker name, KV bindings, compatibility flags
  src/
    index.ts                 # HTTP entry: route + signature verify + dispatch
    app.ts                   # issue_comment handling and /roastmypr routing
    command.ts               # Parse first-line /roastmypr
    github.ts                # App JWT, installation Octokit, PR context, compare delta, comments
    diffPack.ts              # Noise filtering, priority ranking, hunk packing, per-provider budgets
    pathFilter.ts            # Path/evidence/intent filters, F1 accounting, hedge strip
    roast.ts                 # LLM client with Gemini → Workers AI → Groq failover
    responseText.ts          # Normalize / extract usable model completions
    prompts.ts               # Roast personality, review state, coverage warnings
    rateLimit.ts             # KV daily caps
    types.ts                 # Env, command, finding and review-state types
    *.test.ts                # Node test-runner suites (npm test)
  docs/
    ARCHITECTURE.md          # This file
    GITHUB_APP_SETUP.md      # Create the App: permissions, PKCS#8 key, smee, install
  README.md                  # Self-host setup guide
```

| Module | Responsibility |
| --- | --- |
| `index.ts` | Cloudflare `fetch` handler; webhook path; signature check; JSON parse |
| `app.ts` | Business rules: is this `/roastmypr`? orchestrate rate limit, review state, delta, roast, reply |
| `command.ts` | Parse the first line of a comment for `/roastmypr` |
| `github.ts` | All GitHub API interaction through Octokit (prior roast lookup with state, compare delta, comments) |
| `diffPack.ts` | Skip noisy files; rank the rest by tier (source → other → config → tests → docs), then deleted, then renamed, then high-signal paths (`package.json`, `env.*`/`schema.*`, `*controller*`), then larger patches, with paths cited in a prior roast pulled to the front; pack patches by hunk to a budget; report partial coverage |
| `pathFilter.ts` | Drop bullets citing unpacked paths or unverified absolute claims; strip Fix-its that undo commit constraints; strip F1/F2 accounting and hedge closers |
| `roast.ts` | Multi-provider LLM request/response, per-provider packing, delta budget, failover, post-processing |
| `responseText.ts` | Turn provider JSON into plain roast text; prefer `content` over unfinished reasoning |
| `prompts.ts` | Prompt text, footer/state round-trip, finding parsing, partial-coverage banner |
| `rateLimit.ts` | Read/increment KV counters (`RATE_LIMIT` binding required) |
| `types.ts` | Shared `Env`, `RoastCommand`, `PriorFinding`, `RoastState`, `PackCoverage` types |

### 5.1 Review memory (why a re-roast does not repeat a fixed item)

Prose reviews cannot answer "did the author fix F2?" on a later run — the next model sees a *cumulative* base…head diff and a wall of prior text, so anything the packer clipped reads as "still missing". Three pieces of state close that gap:

| Piece | Where it lives | What it buys |
| --- | --- | --- |
| Reviewed SHA | HTML comment in the roast footer (`<!-- roastmypr-state … -->`), invisible when rendered | Lets the next run ask GitHub exactly what changed |
| Findings `F1..Fn` | Same footer, parsed from the roast’s bullets | Gives the next model a checklist to answer, not a vibe to match |
| Delta diff | `repos.compareCommitsWithBasehead(reviewedSha…head)` | Proof that the fix exists, which is what the model actually needed |

The next run then requires one accounting line per finding (`resolved` / `still present — "<quote>"` / `unverifiable`) and enforces it: bullets that contradict a declared resolution are removed, and findings the run could not see must be marked `unverifiable` rather than re-raised. Because the delta consumes 30% of the provider budget, adding memory does not increase prompt size.

Known limits: state travels inside the comment, so a deleted roast comment loses memory (the run degrades to bullet-derived findings); a force-push makes `compare` fail and the run continues without a delta; and coverage on the Groq last-resort pack is still thin, which is why partial runs are labelled instead of trusted.

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
- Workers AI uses the wrangler `[ai]` binding (`env.AI`) — no secret. Override model with `WORKERS_AI_MODEL`.
- If migrating from OpenRouter: `npx wrangler secret delete OPENROUTER_API_KEY`

### 6.4 Trust and privacy

The Worker receives PR diffs for repos where the App is installed. For a self-hosted, account-only bot, that means **your** repos and **your** API keys. Diffs go to Gemini first; on failover they may also be sent to Groq and/or Workers AI. Free-tier providers may use prompts/responses to improve products—document that for operators of a self-hosted copy.

## 7. Local development vs production

### Production

```mermaid
flowchart LR
  GitHub -->|HTTPS webhook| WorkerURL["worker.workers.dev"]
  WorkerURL --> LLM[Gemini Groq WorkersAI]
```

Webhook URL on the GitHub App points at the deployed Worker.

### Local development

GitHub cannot reach `localhost` directly. A relay such as **smee.io** provides a public URL that forwards events to `wrangler dev` on your machine:

```mermaid
flowchart LR
  GitHub -->|webhook| Smee[smee.io public URL]
  Smee -->|forward| Local["wrangler dev on localhost"]
  Local --> LLM[Gemini Groq WorkersAI]
```

Flow for a developer:

1. `wrangler dev` runs the Worker locally
2. Smee (or similar) tunnels GitHub → local
3. Temporarily set the App webhook URL to the smee URL
4. Comment `/roastmypr` on a test PR in an installed repo
5. After deploy, point the webhook back at the production Worker URL

### Checks before shipping a change

```bash
npm run typecheck   # tsc --noEmit
npm test            # Node test runner over src/*.test.ts
```

The suites cover command parsing, packing and hunk selection, the path/evidence/intent filters, review-state round-trip, and provider response parsing — all pure functions, so they need no Cloudflare credentials or network access.

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
| Provider budget covers less than half the PR, or patch text was clipped | Roast is prefixed with the coverage banner; Workers AI / Groq runs get the louder "Partial review via fallback model" variant. Clipped files are named to the model. PRs with fewer than 8 changed files are exempt |
| Author pushes fixes, then re-runs the bot | Compare delta injected as "changes pushed since that review"; every finding must be answered `resolved` / `still present` / `unverifiable` |
| Reviewed SHA is gone (force-push/rebase) | Compare fails; the run continues without a delta and unseen findings become `unverifiable` |
| Model re-raises something it marked resolved | Bullet is dropped by the repeat filter before posting |
| All configured LLMs rate-limited / quota | User-visible “try later” comment |
| KV daily cap exceeded | User-visible limit comment; no LLM call |

## 10. Explicit non-goals (v1)

- Public “Any account” installs sharing one set of LLM keys
- Inline file/line review comments
- Auto-roast on every `pull_request` opened
- Bring-your-own-key dashboards
- GitHub Marketplace listing
- Paid-only model fallbacks (Groq free tier + Workers AI free Neurons only)

## 11. Mental model summary

Think of the system as three doors and one brain:

1. **GitHub App door** — Who is allowed to act in which repos, and which events are sent  
2. **Worker door** — Public HTTPS endpoint that only trusts signed GitHub traffic  
3. **LLM brain** — Turns diff + roast instructions into the comment text (Gemini, with Workers AI / Groq failover)
4. **KV latch** — Stops you from accidentally exhausting free-tier quota  

The slash command is only a **user-facing trigger**. All real work is webhook → verify → auth → diff → model → comment.

## Related docs

- [GITHUB_APP_SETUP.md](./GITHUB_APP_SETUP.md) — create the App, secrets, smee, install on repos
- [../README.md](../README.md) — clone, KV, deploy, commands
