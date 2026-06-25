# phone-claw

phone-claw connects a Twilio phone number to an ElevenLabs Conversational AI agent and gives that agent authenticated tool calls for web search, GitHub, Gmail through Himalaya CLI, Otter transcripts, configured RSS feeds, archived conversation memory, and explicit Claude Code escalation.

This repo is public-safe. Real API keys, account IDs, phone numbers, webhook tokens, tunnel tokens, CLI auth files, local deploy config, and private feed URLs stay in ignored files or provider secret stores.

## Repository Layout

- `cloudflare-worker/` - public Worker for Twilio, ElevenLabs tool webhooks, diagnostics, proxying, and the visualizer.
- `fastify-app/` - private Fastify bridge that runs on EC2 and executes local CLI-backed tools.
- `shared/` - code shared by the Worker and Fastify bridge, including web search.
- `visualizer-app/` - React Router source for the password-protected live conversation dashboard.
- `setup-and-testing-scripts/` - ElevenLabs configuration, export, and live smoke-test scripts.
- `docs/` - architecture, EC2, and bridge-security notes.
- `elevenlabs-setup/` and `twilio-setup/` - provider setup notes and public-safe config snapshots.
- `.env.example` - local environment template.

## Runtime Architecture

```text
Inbound phone call
  -> Twilio number
  -> Cloudflare Worker /twilio/inbound
  -> ElevenLabs register-call API
  -> ElevenLabs live agent
  -> authenticated webhook tool calls back to Cloudflare Worker
  -> Worker handles edge-safe tools or proxies CLI tools through Cloudflare Tunnel
  -> EC2 Fastify bridge on 127.0.0.1:8000
  -> local CLIs, configured RSS files, Claude Code, and Neon/Postgres
```

The Worker is the public HTTPS edge. The EC2 bridge is private because Cloudflare Workers cannot spawn local binaries such as `himalaya`, `otter`, `gh`, or `claude`. Every tool call is bearer-token authenticated at the Worker, and bridge-backed routes are authenticated again with `CLI_BRIDGE_TOKEN`.

## What Runs Where

| Layer | What is set up | Why it exists |
| --- | --- | --- |
| Twilio | The phone number sends inbound calls and call/media-stream callbacks to the Worker. | Twilio owns PSTN telephony and bridges caller audio to ElevenLabs. |
| ElevenLabs | `Andrew Assistant Agent`, Twilio telephony audio format `ulaw_8000`, Jessi voice, two-hour max call duration, inline webhook tools, and the built-in `end_call` tool. | This is the voice agent and tool-calling brain. |
| Cloudflare Worker | `webhooks.aifurman.com` handles Twilio webhooks, tool auth, web search, GitHub/CLI proxy routes, visualizer APIs, Twilio diagnostics, and conversation archive triggers. | Public, low-latency HTTPS surface with secrets in Worker secret storage. |
| Cloudflare KV | `TWILIO_EVENT_LOGS` stores recent Twilio call and Media Stream diagnostic events. | Lets `/twilio/events` explain dropped/static/busy calls without combing provider UI by hand. |
| Cloudflare Tunnel | Exposes the EC2 Fastify bridge to the Worker without opening a public bridge port. | Keeps CLI credentials off the public internet. |
| AWS EC2 | Runs `phoneclaw-bridge.service` on `127.0.0.1:8000`, `phoneclaw-cloudflared.service`, and authenticated CLIs under the `phoneclaw` service user. | Durable host for local CLIs, Claude Code jobs, RSS feed config, and service-user credential state. |
| AWS S3 | Not currently used by phone-claw. There is no committed S3 bucket, S3 route, CloudFront distribution, or S3-backed visualizer asset path. | The visualizer is embedded into the Worker bundle. If S3 is added later, document bucket purpose, IAM policy, data class, and retention here. |
| AWS CLI | Installed/authenticated on the EC2 bridge with `AWS_PROFILE=phoneclaw-personal`. | Available to confirmed Claude Code jobs or operator workflows; no ElevenLabs tool directly wraps arbitrary AWS CLI commands today. |
| Neon/Postgres | Optional conversation archive database via `CONVERSATION_DATABASE_URL`. | Stores summaries, transcript JSON, keywords, tool calls, and tool results for conversation memory. |
| GitHub | Public repo plus bridge-side authenticated `gh` session. | Powers issue/PR summaries, file reads, issue creation/update, and common read-only GitHub CLI actions. |
| Gmail/Himalaya | Himalaya CLI authenticated on EC2. | Gives the agent Gmail list/read/archive/draft/reply/forward/emergency-send capabilities without putting Gmail credentials in Cloudflare. |
| Otter/Otter CLI | Otter CLI authenticated on EC2. | Lets the agent list, fetch, and search Otter transcript JSON. |
| Tavily, DuckDuckGo, Wikipedia | Web search provider chain. | Tavily is preferred; DuckDuckGo and Wikipedia are no-key fallbacks when provider responses fail or return empty results. |
| Configured RSS feeds | Feed URLs in `RSS_FEEDS_CONFIG_PATH` or `RSS_FEEDS_JSON` on EC2. | Lets the agent read generic public or private RSS/Atom feeds without putting publisher-specific scraping in phone-claw. |

## Cloudflare Setup

The Worker exposes:

- Twilio routes: `POST /twilio/inbound`, `POST /twilio/outbound`, `POST /twilio/stream-status`, `POST /twilio/call-status`, `GET /twilio/events`, and `GET|POST /twilio/test-say`.
- ElevenLabs tool routes: `POST /web-search`, GitHub routes, `/cli/*` proxy routes, RSS routes, Claude Code route, and conversation-history routes.
- Visualizer routes: `GET /visualizer`, `GET /visualizer/api/bootstrap`, `GET /visualizer/api/conversations/:conversation_id`, and `POST /visualizer/api/archive-latest`.
- Legacy/future command route: `POST /agent-command`; current Claude Code work should use `claude_code`.

Important Worker secrets:

```bash
wrangler secret put ELEVENLABS_API_KEY
wrangler secret put COMMAND_BRIDGE_TOKEN
wrangler secret put WEB_SEARCH_TOKEN
wrangler secret put TAVILY_API_KEY
wrangler secret put TWILIO_WEBHOOK_TOKEN
wrangler secret put ALLOWED_CALLER_NUMBERS
wrangler secret put OUTSIDE_COVERAGE_MESSAGE
wrangler secret put CLI_BRIDGE_URL
wrangler secret put CLI_BRIDGE_TOKEN
wrangler secret put VISUALIZER_PASSWORD
```

The Worker handles `web_search` directly. It proxies bridge-backed routes to `CLI_BRIDGE_URL` with `CLI_BRIDGE_TOKEN`; it never executes shell commands itself.

## AWS EC2 Setup

The EC2 bridge runs directly on Ubuntu, without Docker:

- `phoneclaw-bridge.service`: Fastify app bound to localhost.
- `phoneclaw-cloudflared.service`: tunnel connector from Cloudflare to localhost.
- CLI binaries: `himalaya`, `otter`, `gh`, `aws`, `railway`, `vercel`, `wrangler`, and `claude`.
- Host-local config/secrets under `/etc/phoneclaw/`, `/home/phoneclaw/.config/`, `/home/phoneclaw/.otterai/`, `/home/phoneclaw/.claude/`, and `/home/phoneclaw/.aws/`.

Security baseline:

- No public HTTP/HTTPS port for the bridge.
- AWS security group and UFW restrict SSH to Andrew's current IP.
- Fastify requires `CLI_BRIDGE_TOKEN` for all CLI/Claude/conversation-history routes.
- CLI tools run as a non-admin `phoneclaw` service user.
- Write tools are confirmation-gated in both the prompt and backend.

See [docs/EC2_BARE_METAL_BRIDGE.md](docs/EC2_BARE_METAL_BRIDGE.md) and [docs/CLI_BRIDGE_SECURITY.md](docs/CLI_BRIDGE_SECURITY.md).

## ElevenLabs Setup

`npm run elevenlabs:tools:configure` updates the live ElevenLabs agent. It patches inline `prompt.tools` because that is the active execution path for the current agent, and it also updates the shared tool definitions for consistency. It validates that `web_search` points at `https://webhooks.aifurman.com/web-search` and has the expected diagnostics/result-count schema.

Current important settings:

- Agent: `Andrew Assistant Agent`.
- Telephony audio: ASR `ulaw_8000`, TTS `ulaw_8000`.
- Voice: Jessi, with `supported_voices: []` to reduce voice drift.
- Max duration: `7200` seconds.
- Built-in system tool: `end_call`.
- Webhook tools use bearer auth, `pre_tool_speech=auto`, and typing sounds for slower calls.

Use:

```bash
npm run elevenlabs:audio:check
npm run elevenlabs:tools:configure
npm run elevenlabs:agent:export
```

## Tool Call Reference

All webhook tool calls are configured on the ElevenLabs agent. Public calls hit the Worker first. Rows marked "EC2 bridge" are then proxied to Fastify, which calls the local CLI or local service.

| Tool | Endpoint | Runs on | Purpose and guardrails |
| --- | --- | --- | --- |
| `web_search` | `/web-search` | Cloudflare Worker | Current facts, news, docs, markets, and schedules. Uses Tavily, then DuckDuckGo, then Wikipedia. Adds WTI market enrichment and FIFA World Cup soccer schedule enrichment when relevant. |
| `github_summary` | `/github-summary` | EC2 bridge via `gh` | Read-only issue/PR triage with `scope`, `repo`, `owner`, and `organization` filters. |
| `github_cli_ls` | `/github-cli/ls` | EC2 bridge via `gh` | Read-only repository root/folder/tree listing. Returns a `gh_equivalent`. |
| `github_cli_cat` | `/github-cli/cat` | EC2 bridge via `gh` | Read-only file content fetch by exact path/ref, capped by `max_bytes`. |
| `github_issue_create` | `/github-issues/create` | EC2 bridge via `gh` | Creates an issue only after exact repo/title/body confirmation and `confirmed=true`. |
| `github_issue_update` | `/github-issues/update` | EC2 bridge via `gh` | Updates title/body/state/labels/assignees only after exact confirmation and `confirmed=true`. |
| `github_cli_common` | `/cli/github/common` | EC2 bridge via `gh` | Read-only `repo_view`, `issue_list`, `issue_view`, `pr_list`, `pr_view`, `search_issues`, and `search_prs`. |
| `himalaya_email_list` | `/cli/himalaya/email-list` | EC2 bridge via Himalaya CLI | Lists/searches Gmail envelopes. Paginated by default; `all_pages=true` is capped for count/complete-list questions. |
| `himalaya_email_read` | `/cli/himalaya/email-read` | EC2 bridge via Himalaya CLI | Reads one envelope by id. Returns compact decoded headers/body excerpt; raw source is opt-in. |
| `himalaya_email_archive` | `/cli/himalaya/email-archive` | EC2 bridge via Himalaya CLI | Moves one or more confirmed envelopes to the archive folder. Requires `confirmed=true`. |
| `himalaya_draft_create` | `/cli/himalaya/draft-create` | EC2 bridge via Himalaya CLI | Saves a new email draft. Requires confirmation; never sends. |
| `himalaya_draft_reply` | `/cli/himalaya/draft-reply` | EC2 bridge via Himalaya CLI | Compatibility reply-draft tool. Prefer `create_reply_all_draft` for reply-all. |
| `himalaya_email_forward` | `/cli/himalaya/email-forward` | EC2 bridge via Himalaya CLI | Compatibility forward-draft tool. Prefer `create_forward_draft`. |
| `create_reply_all_draft` | `/cli/himalaya/create-reply-all-draft` | EC2 bridge via Himalaya CLI | Saves a reply-all draft with Andrew's message above the quoted original thread; preserves original HTML when available. Requires confirmation; never sends. |
| `create_forward_draft` | `/cli/himalaya/create-forward-draft` | EC2 bridge via Himalaya CLI | Saves a forward draft with Andrew's message above the original email; preserves original HTML inline and does not attach `.eml`. Requires confirmation; never sends. |
| `himalaya_email_send` | `/cli/himalaya/email-send` | EC2 bridge via Himalaya CLI | Emergency-only send. Requires exact verbal preview plus `emergency=true`, `previewed=true`, and `confirmed=true`. |
| `otter_speeches_list` | `/cli/otter/speeches-list` | EC2 bridge via Otter CLI | Lists recent Otter speeches/transcripts. |
| `otter_speech_get` | `/cli/otter/speech-get` | EC2 bridge via Otter CLI | Fetches raw transcript JSON for a speech id/otid, capped for voice use. |
| `otter_speech_search` | `/cli/otter/speech-search` | EC2 bridge via Otter CLI | Searches transcript segments by query and optional speaker. |
| `rss_list_feeds` | `/cli/rss/feeds` | EC2 bridge | Lists configured RSS/Atom feeds from host-local config with private URLs redacted. |
| `rss_recent_entries` | `/cli/rss/recent` | EC2 bridge | Lists recent feed entries. Use 10 for quick lists, 25 for spoken browsing, 100 for scanning, 200 for high-default processing, 1000 only when explicitly requested. |
| `rss_search_entries` | `/cli/rss/search` | EC2 bridge | Searches configured feeds by keyword and optional date range. Same limits as recent entries. |
| `rss_get_article_text` | `/cli/rss/article-text` | EC2 bridge | Returns article text from feed content fields for an exact entry id or URL. Reports `full_article_available` and `access_note` when text is only an excerpt. |
| `rss_refresh_feeds` | `/cli/rss/refresh` | EC2 bridge | Refreshes bridge feed cache only when explicitly requested. |
| `conversation_history_search` | `/conversation-history/search` | EC2 bridge plus Neon/Postgres | Searches archived calls by keyword/date and returns compact summaries and keywords. |
| `conversation_history_get` | `/conversation-history/get` | EC2 bridge plus Neon/Postgres | Gets one archived conversation with capped transcript/tool excerpts when requested. |
| `claude_code` | `/cli/claude-code` | EC2 bridge via Claude Code | Explicit escalation only. Supports `auth_status`, `start_session`, `submit_task`, `steer_session`, and `job_status`. Task submission and steering are confirmation-gated; run jobs are async. |
| `end_call` | ElevenLabs built-in | ElevenLabs | Ends the live call after a clear goodbye or "done for now" intent. |

## Himalaya CLI Behavior

Himalaya runs only on the EC2 bridge. The Worker validates the ElevenLabs bearer token and forwards the request; Fastify validates `CLI_BRIDGE_TOKEN` and then calls fixed Himalaya wrappers, not arbitrary shell text.

Email read tools are safe by default:

- `himalaya_email_list` returns compact envelope metadata: id, subject, from, to, date, flags, and attachment presence.
- `himalaya_email_read` returns decoded headers and a bounded body excerpt.
- Raw email source requires `include_raw=true`.

Email write tools are split by risk:

- Draft and archive tools require exact voice confirmation.
- Reply-all and forward drafts preserve original content inline and do not send.
- `himalaya_email_send` is separate, emergency-only, preview-gated, confirmation-gated, and timeout-bounded so SMTP hangs do not silently look successful.

## Conversation Memory

When `CONVERSATION_DATABASE_URL` is set on the bridge, phone-claw can archive ElevenLabs conversations into Neon/Postgres.

- The Worker asks the bridge for recent summaries before a call and passes them to ElevenLabs as `recent_conversation_context`.
- The Worker triggers best-effort archiving on terminal Twilio call status.
- `deploy/phoneclaw-conversation-archive.timer` is the EC2 retry backstop for late ElevenLabs transcript finalization.
- `conversation_history_search` and `conversation_history_get` expose the archive to the agent without dumping full transcripts into every call.

## Live Visualizer

`GET /visualizer` serves a password-protected React Router dashboard from the Worker. It shows live/recent conversations, archived summaries, transcript turns, tool calls/results, Twilio diagnostics, and action links for GitHub issues, Gmail drafts, and RSS articles.

The visualizer is built with:

```bash
npm run visualizer:build
npm run worker:deploy
```

It is embedded into `cloudflare-worker/visualizer-assets.generated.mjs`; it is not served from S3.

## Local Development

```bash
npm install
cp .env.example .env
npm start
```

Common checks:

```bash
npm run check
npm run worker:check
npm run web-search:fallbacks:test
npm run elevenlabs:web-search:test
npm run elevenlabs:rss:conversation:test
npm run elevenlabs:end-call:test
npm run elevenlabs:claude-steering:test
```

## PR And Merge Policy

All non-trivial changes should go through a pull request before merging to `main`.

Before merging a PR that changes agent behavior, tool schemas, tool endpoints, Twilio/ElevenLabs routing, or the EC2 bridge, run the most relevant automated ElevenLabs bot test. For RSS changes, run `npm run elevenlabs:rss:conversation:test`; for end-call behavior, run `npm run elevenlabs:end-call:test`; for Claude Code steering changes, run `npm run elevenlabs:claude-steering:test`; for GitHub, email, logging, search, or audio changes, run the matching `elevenlabs:*:test` script. After the test, review the resulting ElevenLabs transcript and bridge/Worker logs for tool errors, timeouts, or dropped media streams.

## Secret Handling

Do not commit:

- `.env`
- `.dev.vars`
- `wrangler.toml`
- `.wrangler/`
- provider API keys, auth tokens, recovery codes, account credentials, SSH keys, private feed URLs, or CLI auth files

Use `.env.example` and `cloudflare-worker/wrangler.example.toml` as templates only.
