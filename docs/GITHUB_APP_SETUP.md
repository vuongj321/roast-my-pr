# Creating the GitHub App (account-only)

Do this once per self-hosted copy. The code in this repo is useless until an App registration points its webhook at your Worker.

## 1. Create the App

1. Open [GitHub → Settings → Developer settings → GitHub Apps → New GitHub App](https://github.com/settings/apps/new)  
   (Or for an org: `https://github.com/organizations/ORG/settings/apps/new`)
2. Fill in:
   - **GitHub App name:** e.g. `Roast my PR` (must be unique on GitHub)
   - **Homepage URL:** your repo URL or Worker URL
   - **Webhook URL:**  
     - Local: a [smee.io](https://smee.io) channel URL (temporary)  
     - Production: `https://<your-worker-subdomain>.workers.dev/api/github/webhooks`
   - **Webhook secret:** generate a long random string (save it; becomes `WEBHOOK_SECRET`)
3. **Repository permissions:**
   - **Contents:** Read-only
   - **Issues:** Read & write
   - **Pull requests:** Read-only
   - **Metadata:** Read-only (default)
4. **Subscribe to events:** check **Issue comment**
5. **Where can this GitHub App be installed?** → **Only on this account**
6. Click **Create GitHub App**

## 2. Credentials

On the App settings page:

1. Copy **App ID** → `APP_ID`
2. **Generate a private key** → downloads a `.pem` file
3. Convert to **PKCS#8** (required for Workers Web Crypto):

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in path/to/private-key.pem -out private-key-pkcs8.pem
```

On Windows (Git Bash or WSL), the same `openssl` command works.

4. Store the PKCS#8 contents as Cloudflare secret `PRIVATE_KEY` (and in `.dev.vars` for local).

## 3. Install on your repos

1. App settings → **Install App** → install on your account
2. Choose **All repositories** or **Only select repositories**
3. `/roastmypr` only works on those installed repos

## 4. Local webhook forwarding (smee)

1. Open [https://smee.io](https://smee.io) → **Start a new channel** → copy the URL
2. Set the GitHub App **Webhook URL** to that smee URL
3. In one terminal:

```bash
npx smee-client --url https://smee.io/YOUR_CHANNEL --path /api/github/webhooks --port 8787
```

4. In another: `npm run dev` (Wrangler default port is often `8787`)
5. Comment `/roastmypr` on a PR in an installed repo

When you deploy for real, change the App webhook URL to your Worker URL and redeliver a ping from the App’s **Advanced** tab to confirm.

## 5. Gemini API key

1. Open [Google AI Studio](https://aistudio.google.com/apikey) and create an API key
2. Stay on the **free tier** project if you want $0 cost
3. Store as `GEMINI_API_KEY`
4. Optional: set `GEMINI_MODEL` (default `gemini-3.6-flash`) to a model that still shows Free Tier in AI Studio for your project
