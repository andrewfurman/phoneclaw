# phone claw

phone claw is a small voice bridge for calling a Twilio phone number and being connected to an ElevenLabs voice agent. The current repo contains a local Fastify app, a Cloudflare Worker version for the public webhook, setup notes for Twilio and ElevenLabs, tool-call sound settings for slower webhook calls, and a starter webhook tool config for the later Claude Code bridge.

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

| Service | Role in phone claw | Config and secrets |
| --- | --- | --- |
| Twilio | Owns the phone number, receives inbound calls, sends voice/status webhooks, and bridges phone audio through Media Streams. | Twilio account settings plus Worker secrets such as `TWILIO_WEBHOOK_TOKEN`, `ALLOWED_CALLER_NUMBERS`, and `OUTSIDE_COVERAGE_MESSAGE`. Setup notes live in `twilio-setup/`. |
| ElevenLabs | Hosts the Conversational AI voice agent, voice settings, LLM settings, and webhook tool definitions. | `ELEVENLABS_AGENT_ID` in Worker config, `ELEVENLABS_API_KEY` as a secret, and sanitized exported config in `elevenlabs-setup/`. |
| Cloudflare Workers | Public HTTPS layer for Twilio and ElevenLabs webhooks. It validates callers, registers Twilio calls with ElevenLabs, proxies tool calls, and serves diagnostics. | `cloudflare-worker/`, `wrangler.toml` locally, Worker secrets in Cloudflare. |
| Cloudflare KV | Stores recent Twilio call and Media Stream diagnostic events. | `TWILIO_EVENT_LOGS` binding in Worker config. |
| React Router | Password-protected live conversation visualizer served by the Worker at `/visualizer` and the `phoneclaw.aifurman.com` custom domain. | `visualizer-app/` source, generated Worker assets, and `VISUALIZER_PASSWORD` as a Worker secret. |
| Cloudflare Tunnel | Exposes the private CLI bridge to the Worker without opening a raw public port. | Tunnel config and token live outside the public repo. |
| AWS EC2 | Runs the long-lived private Fastify CLI bridge because Workers cannot spawn local CLI binaries. | EC2 setup is documented in `docs/EC2_BARE_METAL_BRIDGE.md`; AWS credentials and instance secrets stay outside the repo. |
| GitHub | Stores this public repo and backs agent tools for issue/PR summaries, file reads, and confirmed issue create/update actions. | The EC2 bridge uses the authenticated `gh` CLI session for the `phoneclaw` service user. The Worker only proxies these routes with `CLI_BRIDGE_TOKEN`; no GitHub PAT is required in Cloudflare. |
| Tavily | Preferred LLM-oriented web search provider for fast, compact voice answers. | Optional `TAVILY_API_KEY` Worker secret. With `WEB_SEARCH_PROVIDER=auto`, the Worker uses Tavily when the key exists and falls back to DuckDuckGo otherwise. |
| DuckDuckGo | No-key fallback web search provider. | No secret required. Used only when Tavily is not configured. |
| Yahoo Finance public chart API | Market-history enrichment for WTI crude high/low/range questions. | No secret required. Used as a compact fallback to avoid relying only on generic search snippets. |
| ESPN public scoreboard endpoint | Prototype sports enrichment for FIFA World Cup schedule/score queries. | No secret required. Treat as a convenience endpoint, not a committed long-term sports-data contract. |
| Neon | Optional Postgres archive for phone claw conversation memory. Stores transcript JSON, summaries, keywords, and tool-call logs. | `CONVERSATION_DATABASE_URL` on the bridge. `NEON_API_KEY` is used only by the setup script and should not be committed. |
| Configured RSS feeds | Public or private RSS/Atom feeds exposed to the voice agent by feed id. | Store feed URLs in `RSS_FEEDS_CONFIG_PATH` or `RSS_FEEDS_JSON` on the EC2 bridge. Private URLs are redacted in tool responses and should never be committed. |
| Miniflux/RSS-Bridge | Legacy RSS backends kept for compatibility while configured feeds replace publisher-specific tooling. | Legacy settings remain documented in `docs/EC2_BARE_METAL_BRIDGE.md`; new integrations should prefer generic configured feeds. |
| Gmail | Email account accessed through the private CLI bridge for listing, reading previews, archiving, saving drafts/reply drafts/forward drafts, and emergency-only confirmed sends. | Authenticated locally on the bridge host through Himalaya CLI config; no Gmail credentials are committed. |
| Himalaya CLI | Local email CLI used by the private bridge to access Gmail. | `HIMALAYA_BIN`, `HIMALAYA_ARCHIVE_FOLDER`, and `HIMALAYA_DRAFTS_FOLDER` in bridge env. |
| Otter.ai | Transcript source for listing, fetching raw transcript JSON, and transcript search. | Authenticated on the bridge host through Otter CLI config; no Otter credentials are committed. |
| Otter CLI | Local CLI used by the private bridge to access Otter transcripts. | `OTTER_BIN` in bridge env. |
| Claude Code | Optional explicit escalation target for complex code changes and test runs. The voice agent can start/check/steer sessions and submit async jobs on the EC2 bridge only after confirmation. | `CLAUDE_BIN`, `CLAUDE_CODE_JOB_DIR`, `CLAUDE_CODE_STEERING_DIR`, `CLAUDE_CODE_ALLOWED_DIRS`, and either Claude Code login state or `ANTHROPIC_API_KEY` on the private bridge. |
| AWS CLI | Available to Claude Code on the EC2 bridge for AWS account operations when explicitly requested. | `AWS_PROFILE=phoneclaw-personal` on the bridge. Credentials stay in the service user's AWS config, not the repo. |
| Railway CLI, Vercel CLI, Wrangler | Installed on the EC2 bridge for future deployment workflows. | These CLIs still require token/login configuration before use. |

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

## PR And Merge Policy

All non-trivial changes should go through a pull request before merging to `main`.

Before merging a PR that changes agent behavior, tool schemas, tool endpoints, Twilio/ElevenLabs routing, or the EC2 bridge, run the most relevant automated ElevenLabs bot test. For Economist/RSS changes, run `npm run elevenlabs:rss:conversation:test`; for GitHub, email, logging, or audio changes, run the matching `elevenlabs:*:test` script. After the test, review the resulting ElevenLabs conversation transcript and bridge/Worker logs for tool errors, timeouts, or dropped media streams. Merge only after the automated test and logs support the change.

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

The hosted Worker proxies these GitHub routes to the private EC2 bridge. The bridge executes authenticated `gh` commands under the `phoneclaw` service user, so private and organization repository access follows that GitHub CLI session, including any required SSO or org approval.

Authenticate or refresh the bridge login as the service user:

```bash
sudo -iu phoneclaw gh auth login --hostname github.com --scopes repo,read:org,workflow
```

Do not store GitHub PATs as Worker secrets for these tools.

## CLI Bridge Tools

The ElevenLabs agent also has focused wrappers for local CLIs:

- `himalaya_email_list` and `himalaya_email_read`
- `himalaya_email_archive`, `himalaya_draft_create`, `create_reply_all_draft`, `create_forward_draft`, and `himalaya_email_send`
- `otter_speeches_list`, `otter_speech_get`, and `otter_speech_search`
- `github_cli_common`
- `rss_list_feeds`, `rss_recent_entries`, `rss_search_entries`, `rss_get_article_text`, and `rss_refresh_feeds`
- `conversation_history_search` and `conversation_history_get`
- `claude_code`

Email write tools require explicit confirmation. They can archive email and save drafts by default. `create_reply_all_draft` saves a reply-all draft with Andrew's message above the quoted original thread. `create_forward_draft` saves a forward draft with Andrew's message above the original email and preserves the original HTML inline when available, without attaching the original `.eml`. `himalaya_draft_reply` and `himalaya_email_forward` remain as compatibility aliases for older agent prompts. `himalaya_email_send` is a separate emergency-only send tool that requires an exact verbal preview and a second explicit confirmation before sending.

`himalaya_email_list` is paginated by default and returns compact envelope metadata only: id, subject, sender, recipients, date, flags, and attachment presence. Use `all_pages=true` on the same tool for complete folder lists and total-count questions such as "how many emails are in my inbox?" All-pages mode returns at most 200 envelopes by default and reports `has_more`, `complete`, and `capped` so the agent does not dump an entire mailbox into context.

`claude_code` is intentionally not a default reasoning path. It supports `auth_status`, `start_session`, `submit_task`, `steer_session`, and `job_status`; task submission and steering instructions are confirmation-gated. Run jobs are asynchronous on the private EC2 bridge, and steering instructions let Andrew update or redirect the same Claude Code session instead of starting over.

`rss_*` tools read configured RSS or Atom feeds from `RSS_FEEDS_CONFIG_PATH` or `RSS_FEEDS_JSON` on the private EC2 bridge. Each feed has an id, title, URL, optional request headers, privacy flag, and cache TTL. The bridge fetches feed XML only, parses `content:encoded`, Atom `content`, or summary fields, redacts private URLs in responses, and caches feed fetches to avoid repeated polling. Store private full-text feed URLs, including the Economist feed URL, in `/etc/phoneclaw/rss-feeds.json` or another host-local secret file, not in Git or Worker config.

Use `npm run elevenlabs:rss:conversation:test` to run an automated ElevenLabs smoke test for recent-list, keyword/date search, and article-text tool calls.

On the EC2 bridge, run-mode Claude Code jobs may be configured with `CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS=true`. That starts confirmed run jobs with Claude Code `bypassPermissions` plus `--dangerously-skip-permissions`, so jobs do not hang on permission prompts. This setting should be paired with a locked-down bridge: localhost-only Fastify, Cloudflare Tunnel, bearer-token tool auth, restricted SSH, and no public bridge port.

## Conversation Memory

Conversation memory is optional and activates when the bridge has `CONVERSATION_DATABASE_URL` set.

- `npm run neon:setup` creates or reuses a Neon project when `NEON_API_KEY` is present in the shell.
- `npm run conversations:archive` backfills recent ElevenLabs conversations into Postgres.
- The Worker asks the bridge for recent conversation summaries at the start of each call and passes them to ElevenLabs as `recent_conversation_context`.
- The Worker best-effort triggers an archive job when Twilio reports a terminal call status, and the EC2 bridge can run `deploy/phoneclaw-conversation-archive.timer` as a five-minute retry backstop.
- `conversation_history_search` returns compact summaries and keywords.
- `conversation_history_get` retrieves compact archived-call details by default, with capped transcript/tool excerpts when explicitly requested so one old call cannot overload the live agent context.

Cloudflare Workers cannot run those binaries directly. The Worker proxies `/cli/*` requests to a private Fastify bridge configured with `CLI_BRIDGE_URL` and `CLI_BRIDGE_TOKEN`. See `docs/CLI_BRIDGE_SECURITY.md`.

## Live Visualizer

`GET /visualizer` serves a password-protected React Router dashboard from the Cloudflare Worker. It displays recent live ElevenLabs conversations, archived Neon summaries, transcript turns, tool calls/results, recent Twilio events, and action links extracted from tool results.

The dashboard turns GitHub issue results, Gmail draft results, and RSS article results into tap-friendly links. Gmail draft links use Gmail search against the exact draft subject because Himalaya draft ids are not stable Gmail web URLs.

Run `npm run visualizer:build` before deploying the Worker. The build embeds the visualizer output into `cloudflare-worker/visualizer-assets.generated.mjs`. Configure `VISUALIZER_PASSWORD` as a Worker secret, not in committed config. After deployment, validate with `npm run visualizer:test` while `VISUALIZER_PASSWORD` is present in the local shell.

Useful demo scripts:

- `npm run visualizer:demo-test` runs an ElevenLabs text conversation that exercises Economist RSS, Gmail draft creation, and GitHub issue creation.
- `npm run visualizer:screenshots` captures desktop and mobile screenshots of the deployed visualizer. Set `VISUALIZER_CONVERSATION_ID` to pin the screenshots to a specific call.

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
