# Claw Phone

Claw Phone is a small voice bridge for calling a Twilio phone number and being connected to an ElevenLabs voice agent. The current repo contains a local Fastify app, a Cloudflare Worker version for the public webhook, setup notes for Twilio and ElevenLabs, and a starter webhook tool config for the later Claude Code bridge.

This is intentionally public-safe. Real API keys, account IDs, phone numbers, webhook tokens, and local deploy config stay in ignored files or provider secret stores.

## Repository Layout

- `fastify-app/` - local Fastify webhook server.
- `cloudflare-worker/` - Cloudflare Worker webhook used for the hosted prototype.
- `docs/` - setup log, architecture notes, and hosting plan.
- `elevenlabs-setup/` - ElevenLabs agent and tool-call configuration notes.
- `twilio-setup/` - Twilio number and webhook configuration notes.
- `.env.example` - local environment template.

## Local Development

Install dependencies:

```bash
npm install
```

Create a local secrets file:

```bash
cp .env.example .env
```

Start the Fastify webhook:

```bash
npm start
```

Run checks:

```bash
npm run check
npm run worker:check
npm run elevenlabs:github:test
npm run elevenlabs:github:files:test
```

## Cloudflare Worker

Copy the example Worker config and edit it locally:

```bash
cp cloudflare-worker/wrangler.example.toml wrangler.toml
```

Set Worker secrets with Wrangler:

```bash
wrangler secret put ELEVENLABS_API_KEY
wrangler secret put COMMAND_BRIDGE_TOKEN
wrangler secret put TWILIO_WEBHOOK_TOKEN
wrangler secret put ALLOWED_CALLER_NUMBERS
wrangler secret put OUTSIDE_COVERAGE_MESSAGE
wrangler secret put WEB_SEARCH_TOKEN
wrangler secret put GITHUB_READ_TOKEN
wrangler secret put GITHUB_WRITE_TOKEN
```

Create and bind a KV namespace for Twilio stream/call diagnostic callbacks:

```bash
npx wrangler kv namespace create TWILIO_EVENT_LOGS --config wrangler.toml
```

Deploy:

```bash
npm run worker:deploy
```

## Provider Setup

- Twilio setup lives in `twilio-setup/`.
- ElevenLabs setup lives in `elevenlabs-setup/`.
- The setup log lives in `docs/SETUP_LOG.md`.
- The long-term hosting recommendation lives in `docs/HOSTING_PLAN.md`.

## GitHub Tools

The ElevenLabs agent has read-only GitHub webhook tools:

- `github_summary` for issue and pull request triage, with optional `repo`, `organization`, and `owner` filters.
- `github_cli_ls` for GitHub CLI-style repository root, folder, and recursive tree listing.
- `github_cli_cat` for GitHub CLI-style file content reads.
- `github_issue_create` for confirmed GitHub issue creation.
- `github_issue_update` for confirmed GitHub issue updates.

The hosted Worker uses `GITHUB_READ_TOKEN` for reads and `GITHUB_WRITE_TOKEN` for issue writes. Keep both tokens out of the public repo. Prefer fine-grained tokens with the narrowest repo permissions possible.

## Twilio Diagnostics

The Worker adds a Media Streams `statusCallback` to the ElevenLabs TwiML and stores recent stream/call callback events in KV. Use `GET /twilio/events` with the configured auth token to inspect recent `stream-started`, `stream-stopped`, `stream-error`, and call lifecycle callbacks.

## Secret Handling

Do not commit:

- `.env`
- `.dev.vars`
- `wrangler.toml`
- `.wrangler/`
- provider API keys, auth tokens, recovery codes, or account credentials

Use `.env.example` and `cloudflare-worker/wrangler.example.toml` as templates only.
