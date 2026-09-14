import { verify } from "@octokit/webhooks-methods";
import { handleIssueComment } from "./app.js";
import type { Env } from "./types.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function htmlHome(): Response {
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Roast my PR</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { max-width: 40rem; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.5; }
    code { font-size: 0.95em; }
  </style>
</head>
<body>
  <h1>Roast my PR</h1>
  <p>Self-hosted GitHub App. Comment <code>/roastmypr</code> on a pull request to get roasted.</p>
  <p>Webhook endpoint: <code>POST /api/github/webhooks</code></p>
  <p>See the repo README for setup.</p>
</body>
</html>`;
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const signature = request.headers.get("x-hub-signature-256");
  if (!signature) {
    return json({ error: "Missing signature" }, 401);
  }

  const rawBody = await request.text();
  const valid = await verify(env.WEBHOOK_SECRET, rawBody, signature);
  if (!valid) {
    return json({ error: "Invalid signature" }, 401);
  }

  const event = request.headers.get("x-github-event") || "";
  const payload = JSON.parse(rawBody) as Record<string, unknown>;

  // Always ack quickly after verify; do work for the events we care about.
  if (event === "issue_comment") {
    try {
      await handleIssueComment(env, payload);
    } catch (err) {
      console.error("Unhandled issue_comment error", err);
      // Still 200 so GitHub does not hammer retries for app bugs.
    }
  } else if (event === "ping") {
    return json({ ok: true, pong: true });
  }

  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return htmlHome();
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/api/github/webhooks" || url.pathname === "/api/github/webhooks/")
    ) {
      return handleWebhook(request, env);
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
