# Fastify App

The Fastify app is the local development version of the webhook. It mirrors the Worker flow and is useful for local testing with a tunnel.

## Run

From the repo root:

```bash
npm install
cp .env.example .env
npm start
```

Health check:

```bash
curl http://localhost:8000/health
```

The local app mirrors the Worker endpoints, including:

- `POST /twilio/inbound`
- `POST /twilio/stream-status`
- `POST /twilio/call-status`
- `GET /twilio/events`
- `POST /web-search`
- `POST /github-summary`
- `POST /github-cli/ls`
- `POST /github-cli/cat`
- `POST /github-issues/create`
- `POST /github-issues/update`
- `POST /cli/himalaya/email-list`
- `POST /cli/himalaya/email-read`
- `POST /cli/himalaya/email-archive`
- `POST /cli/himalaya/draft-create`
- `POST /cli/himalaya/draft-reply`
- `POST /cli/otter/speeches-list`
- `POST /cli/otter/speech-get`
- `POST /cli/otter/speech-search`
- `POST /cli/github/common`
- `POST /agent-command`

The `/cli/*` endpoints execute focused local CLI wrappers and should run on a private bridge host in production. Email write endpoints are confirmation-gated and cannot send email. See `docs/CLI_BRIDGE_SECURITY.md`.

## Expose Locally

Twilio needs a public HTTPS URL. For local experiments:

```bash
npm run tunnel
```

Then point Twilio at:

```text
https://YOUR_PUBLIC_TUNNEL_URL/twilio/inbound
```

For anything beyond quick testing, prefer the Cloudflare Worker.
