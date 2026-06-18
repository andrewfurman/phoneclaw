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
- `POST /web-search`
- `POST /agent-command`

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
