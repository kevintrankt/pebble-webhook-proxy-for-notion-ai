# Pebble → Notion Webhook Proxy

A Cloudflare Worker that sits between a **Pebble Index 01** (which posts transcriptions via webhook) and the **Notion Agent Sessions API**. The Pebble can't customize its webhook method, headers, or body — this Worker intercepts the request, reshapes it, and forwards it to Notion with the exact headers and JSON body Notion requires.

```
Pebble Index 01  ──(multipart/form-data)──▶  Cloudflare Worker  ──(JSON + auth)──▶  Notion /v1/sessions
```

---

## What it does

1. Receives the Pebble's `POST` request (`multipart/form-data`, not JSON).
2. Authenticates it via a secret in the URL path (the Pebble can't send custom headers).
3. Extracts the `transcription` field (plus `client`, `recordedAt`).
4. Forwards it to `https://api.notion.com/v1/sessions` as a new agent session, with the required `Authorization`, `Notion-Version`, and `Content-Type` headers.
5. Acks the Pebble immediately with `200 ok` so it doesn't retry.

---

## Prerequisites

- **Node.js 18+**
- A **Cloudflare account** (free tier is fine)
- A **Notion integration token** (`ntn_...`) — from <https://www.notion.so/my-integrations>
- A **Notion agent ID** — use `notion_ai` for Notion AI, or a specific agent's UUID
- A **Pebble Index 01** with a configurable webhook URL

---

## Setup

### 1. Clone and install

```bash
git clone <your-repo-url>
cd pebble-webhook-proxy-for-notion-ai
npm install
```

### 2. Authenticate Wrangler with Cloudflare

```bash
npx wrangler login
```

### 3. Generate an inbound secret

This is a random password **you** create to guard the Worker's public URL. Anyone with the full URL can call your Worker, so keep it private.

```bash
openssl rand -hex 16
# example output: 38cfaab65b10d1231bfd5ee176bcfbdb
```

Save the value — you'll use it in two places (local secrets and the Pebble URL path).

---

## Configuration — secrets live in TWO places

This is the most common point of confusion. Local dev and the deployed Worker read secrets from **different** locations:

| Environment | Command | Where it reads from |
|---|---|---|
| Local (`wrangler dev`) | edit `.dev.vars` | a file on your machine |
| Deployed (`wrangler deploy`) | `wrangler secret put` | Cloudflare's servers (remote) |

**You must set both** for the Worker to work locally *and* in production.

### Local secrets — `.dev.vars`

Create a `.dev.vars` file in the project root (same folder as `wrangler.jsonc`). No quotes around values.

```bash
cat > .dev.vars << 'EOF'
INBOUND_SECRET=38cfaab65b10d1231bfd5ee176bcfbdb
NOTION_TOKEN=ntn_your_real_token_here
NOTION_AGENT_ID=notion_ai
EOF
```

Then make sure it's never committed:

```bash
echo ".dev.vars" >> .gitignore
```

### Remote secrets — for the deployed Worker

Run each command and paste the value at the hidden prompt:

```bash
npx wrangler secret put INBOUND_SECRET     # same value as in .dev.vars
npx wrangler secret put NOTION_TOKEN       # your ntn_... token
npx wrangler secret put NOTION_AGENT_ID    # notion_ai, or an agent UUID
```

> `wrangler secret put` never takes the value on the command line — it prompts you and hides input, so the token stays out of your shell history. Never put tokens in `wrangler.jsonc` or `src/index.js`; those get committed.

---

## The Worker code

`src/index.js`:

```js
export default {
  async fetch(request, env, ctx) {
    // --- inbound auth: secret in the URL path (Pebble can't set headers) ---
    const url = new URL(request.url);
    if (url.pathname !== `/${env.INBOUND_SECRET}`) {
      return new Response("nope", { status: 401 });
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    // --- parse the multipart form the Pebble sends ---
    const form = await request.formData();
    const transcription = (form.get("transcription") ?? "").toString().slice(0, 10000);
    const recordedAt = form.get("recordedAt");
    const client = form.get("client");

    // skip Pebble test events (comment out if you want them through)
    if (form.get("test") === "true") {
      return new Response("ok (test skipped)", { status: 200 });
    }
    if (!transcription.trim()) {
      return new Response("ok (empty transcription)", { status: 200 });
    }

    // --- build the Notion session request ---
    const payload = {
      agent_id: env.NOTION_AGENT_ID,   // omit session_id => starts a new session
      message: transcription,
      metadata: {
        source: (client ?? "pebble-index-01").toString(),
        recorded_at: (recordedAt ?? "").toString(),
      },
    };

    const forward = fetch("https://api.notion.com/v1/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.NOTION_TOKEN}`,
        "Notion-Version": "2026-03-11",
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(payload),
    });

    ctx.waitUntil(forward);                        // don't make the Pebble wait
    return new Response("ok", { status: 200 });    // ack fast so it doesn't retry
  },
};
```

---

## Test locally

Start the dev server (reads `.dev.vars` at startup — restart it after any edit):

```bash
npx wrangler dev
```

In a second terminal, send a Pebble-shaped request. Use your inbound secret as the path:

```bash
curl -X POST "http://localhost:8787/38cfaab65b10d1231bfd5ee176bcfbdb" -F "client=ring" -F "recordedAt=1788904222506" -F "transcription=Summarize this week's work."
```

Expected response: `ok`

> **Note on multi-line curl:** a `\` line-continuation only works when it's immediately followed by a newline. If you paste the command flattened onto one line with `\` still in it, curl throws `Bad hostname`. Either keep it on one line with no backslashes, or press Enter after each `\`.

Watch the actual Notion call succeed or fail:

```bash
npx wrangler tail
```

`ok` only means the Worker accepted and *fired* the request (fire-and-forget). It does **not** confirm Notion accepted it — check `wrangler tail` for the real result.

---

## Deploy

```bash
npx wrangler deploy
```

The output prints your live URL:

```
Deployed pebble-webhook-proxy-for-notion-ai
  https://pebble-webhook-proxy-for-notion-ai.<your-subdomain>.workers.dev
```

If you missed it:

```bash
npx wrangler deployments list
```

Verify the live Worker (real URL, not localhost):

```bash
curl -X POST "https://pebble-webhook-proxy-for-notion-ai.<your-subdomain>.workers.dev/38cfaab65b10d1231bfd5ee176bcfbdb" -F "client=ring" -F "recordedAt=1788904222506" -F "transcription=deploy test"
```

Expected: `ok`

---

## Connect the Pebble

Set the Pebble's webhook URL to your deployed base URL **plus the inbound secret as the path**:

```
https://pebble-webhook-proxy-for-notion-ai.<your-subdomain>.workers.dev/38cfaab65b10d1231bfd5ee176bcfbdb
```

Trigger a real recording, then confirm it flows through with `npx wrangler tail`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `nope` (401) | Path doesn't match `INBOUND_SECRET` | Confirm the curl path equals your secret; confirm the secret is set for the environment you're testing |
| `DEBUG expected: undefined` | Worker has no `INBOUND_SECRET` value | Local: create `.dev.vars` and **restart** `wrangler dev`. Remote: run `wrangler secret put INBOUND_SECRET` |
| `.dev.vars: No such file` | File missing | Create it in the project root (see Configuration) |
| Local works, deployed 401s | Remote secrets never set | `wrangler secret put` for all three secrets |
| `ok` but nothing in Notion | Notion rejected it (bad token / agent_id / rate limit) | Check `wrangler tail`; verify `NOTION_TOKEN` and `NOTION_AGENT_ID` |
| curl `Bad hostname` | `\` on a flattened one-line command | Remove backslashes, or press Enter after each `\` |

### Debug the auth check

Add this line temporarily right after `const url = new URL(request.url);`, then watch the `wrangler dev` terminal when you curl:

```js
console.log("DEBUG expected:", JSON.stringify(env.INBOUND_SECRET), "got:", JSON.stringify(url.pathname)); // TODO remove
```

- `expected: undefined` → secret not loaded (see table above)
- extra quotes in the value → you wrapped the value in quotes in `.dev.vars`; remove them
- Remove this line before deploying.

---

## Security notes

- The **inbound secret** is a shared password, not real cryptography. Anyone who sees the full URL (logs, screen-shares) has it. Rotate if exposed: new `openssl rand -hex 16`, update both `.dev.vars` and the remote secret, update the Pebble URL.
- The **inbound secret** and **Notion token** are unrelated: the inbound secret guards who can call your Worker; the Notion token is what your Worker uses to call Notion.
- Never commit `.dev.vars` or paste tokens into source files.

---

## Optional extensions

- **Error logging** — surface failed Notion calls instead of hiding them behind `ok`.
- **Session threading** — persist the returned `session_id` in Workers KV to thread all transcriptions into one running session instead of starting a new one each time.
- **Audio handling** — if the Pebble attaches an audio file part on real recordings, extend `formData()` parsing to handle it.

---

## Reference

- Notion — Create or update a session: <https://developers.notion.com/reference/notion-agent-apis/update-session>
- Cloudflare Workers — Get started: <https://developers.cloudflare.com/workers/get-started/guide/>
- Wrangler CLI: <https://developers.cloudflare.com/workers/wrangler/>
