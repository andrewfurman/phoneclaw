# Claw Phone

Claw Phone is a small voice bridge for calling a Twilio phone number and being connected to an ElevenLabs voice agent. The current repo contains a local Fastify app, a Cloudflare Worker version for the public webhook, setup notes for Twilio and ElevenLabs, tool-call sound settings for slower webhook calls, and a starter webhook tool config for the later Claude Code bridge.

This is intentionally public-safe. Real API keys, account IDs, phone numbers, webhook tokens, and local deploy config stay in ignored files or provider secret stores.

## Repository Layout

- `fastify-app/` - local Fastify webhook server.
- `cloudflare-worker/` - Cloudflare Worker webhook used for the hosted prototype.
- `docs/` - setup log, architecture notes, and hosting plan.
- `elevenlabs-setup/` - ElevenLabs agent and tool-call configuration notes.
- `twilio-setup/` - Twilio number and webhook configuration notes.
- `.env.example` - local environment template.

## Third-Party Services

This project intentionally keeps provider configuration explicit because the voice agent touches phone calls, email, GitHub, search, and personal transcripts.

| Service | Role in Claw Phone | Config and secrets |
| --- | --- | --- |
| Twilio | Owns the phone number, receives inbound calls, sends voice/status webhooks, and bridges phone audio through Media Streams. | Twilio account settings plus Worker secrets such as `TWILIO_WEBHOOK_TOKEN`, `ALLOWED_CALLER_NUMBERS`, and `OUTSIDE_COVERAGE_MESSAGE`. Setup notes live in `twilio-setup/`. |
| ElevenLabs | Hosts the Conversational AI voice agent, voice settings, LLM settings, and webhook tool definitions. | `ELEVENLABS_AGENT_ID` in Worker config, `ELEVENLABS_API_KEY` as a secret, and sanitized exported config in `elevenlabs-setup/`. |
| Cloudflare Workers | Public HTTPS layer for Twilio and ElevenLabs webhooks. It validates callers, registers Twilio calls with ElevenLabs, proxies tool calls, and serves diagnostics. | `cloudflare-worker/`, `wrangler.toml` locally, Worker secrets in Cloudflare. |
| Cloudflare KV | Stores recent Twilio call and Media Stream diagnostic events. | `TWILIO_EVENT_LOGS` binding in Worker config. |
| Cloudflare Tunnel | Exposes the private CLI bridge to the Worker without opening a raw public port. | Tunnel config and token live outside the public repo. |
| AWS EC2 | Runs the long-lived private Fastify CLI bridge because Workers cannot spawn local CLI binaries. | EC2 setup is documented in `docs/EC2_BARE_METAL_BRIDGE.md`; AWS credentials and instance secrets stay outside the repo. |
| GitHub | Stores this public repo and backs agent tools for issue/PR summaries, file reads, and confirmed issue create/update actions. | `GITHUB_READ_TOKEN` and `GITHUB_WRITE_TOKEN` are Worker secrets; the EC2 bridge can also use authenticated `gh` CLI for read-only wrappers. |
| Tavily | Preferred LLM-oriented web search provider for fast, compact voice answers. | Optional `TAVILY_API_KEY` Worker secret. With `WEB_SEARCH_PROVIDER=auto`, the Worker uses Tavily when the key exists and falls back to DuckDuckGo otherwise. |
| DuckDuckGo | No-key fallback web search provider. | No secret required. Used only when Tavily is not configured. |
| ESPN public scoreboard endpoint | Prototype sports enrichment for FIFA World Cup schedule/score queries. | No secret required. Treat as a convenience endpoint, not a committed long-term sports-data contract. |
| Gmail | Email account accessed through the private CLI bridge for listing, reading previews, archiving, and saving drafts. The agent cannot send email. | Authenticated locally on the bridge host through Himalaya CLI config; no Gmail credentials are committed. |
| Himalaya CLI | Local email CLI used by the private bridge to access Gmail. | `HIMALAYA_BIN`, `HIMALAYA_ARCHIVE_FOLDER`, and `HIMALAYA_DRAFTS_FOLDER` in bridge env. |
| Otter.ai | Transcript source for listing, fetching raw transcript JSON, and transcript search. | Authenticated on the bridge host through Otter CLI config; no Otter credentials are committed. |
| Otter CLI | Local CLI used by the private bridge to access Otter transcripts. | `OTTER_BIN` in bridge env. |
| Claude Code | Planned future coding-agent bridge target. Current repo includes starter webhook/tool notes, but no long-running Claude Code session is exposed yet. | Future bridge values are represented by `COMMAND_BRIDGE_TOKEN` and optional Claude bridge env placeholders. |

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
wrangler secret put TAVILY_API_KEY
wrangler secret put CLI_BRIDGE_URL
wrangler secret put CLI_BRIDGE_TOKEN
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
- The bare-metal EC2 bridge guide lives in `docs/EC2_BARE_METAL_BRIDGE.md`.

## GitHub Tools

The ElevenLabs agent has read-only GitHub webhook tools:

- `github_summary` for issue and pull request triage, with optional `repo`, `organization`, and `owner` filters.
- `github_cli_ls` for GitHub CLI-style repository root, folder, and recursive tree listing.
- `github_cli_cat` for GitHub CLI-style file content reads.
- `github_issue_create` for confirmed GitHub issue creation.
- `github_issue_update` for confirmed GitHub issue updates.

The hosted Worker uses `GITHUB_READ_TOKEN` for reads and `GITHUB_WRITE_TOKEN` for issue writes. Keep both tokens out of the public repo. Prefer fine-grained tokens with the narrowest repo permissions possible.

## CLI Bridge Tools

The ElevenLabs agent also has focused wrappers for local CLIs:

- `himalaya_email_list`, `himalaya_email_count`, and `himalaya_email_read`
- `himalaya_email_archive`, `himalaya_draft_create`, and `himalaya_draft_reply`
- `otter_speeches_list`, `otter_speech_get`, and `otter_speech_search`
- `github_cli_common`

Email write tools require explicit confirmation. They can archive email and save drafts; they cannot send email.

`himalaya_email_list` is paginated. Use `himalaya_email_count` for total-count questions such as "how many emails are in my inbox?"

Cloudflare Workers cannot run those binaries directly. The Worker proxies `/cli/*` requests to a private Fastify bridge configured with `CLI_BRIDGE_URL` and `CLI_BRIDGE_TOKEN`. See `docs/CLI_BRIDGE_SECURITY.md`.

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
