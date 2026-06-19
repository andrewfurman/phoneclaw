# Cloudflare Worker Webhook

This Worker is the preferred public webhook layer for the phone prototype. It accepts Twilio webhook calls, registers each call with the ElevenLabs Twilio register-call API, and returns the TwiML that connects the live phone call to the agent.

## Configure

Copy the example config to the repo root:

```bash
cp cloudflare-worker/wrangler.example.toml wrangler.toml
```

Edit `wrangler.toml` with your own Cloudflare account, route, ElevenLabs agent ID, and Twilio phone number. Keep `wrangler.toml` uncommitted.

Set secrets:

```bash
wrangler secret put ELEVENLABS_API_KEY
wrangler secret put COMMAND_BRIDGE_TOKEN
wrangler secret put TWILIO_WEBHOOK_TOKEN
wrangler secret put ALLOWED_CALLER_NUMBERS
wrangler secret put OUTSIDE_COVERAGE_MESSAGE
wrangler secret put WEB_SEARCH_TOKEN
wrangler secret put CLI_BRIDGE_URL
wrangler secret put CLI_BRIDGE_TOKEN
wrangler secret put GITHUB_READ_TOKEN
wrangler secret put GITHUB_WRITE_TOKEN
```

Create a KV namespace for Twilio stream/call event diagnostics, then add the returned ID to local `wrangler.toml`:

```bash
npx wrangler kv namespace create TWILIO_EVENT_LOGS --config wrangler.toml
```

Deploy from the repo root:

```bash
npm run worker:deploy
```

## Endpoints

- `GET /health`
- `POST /twilio/inbound`
- `POST /twilio/outbound`
- `POST /twilio/stream-status`
- `POST /twilio/call-status`
- `GET /twilio/events`
- `GET|POST /twilio/test-say`
- `POST /web-search`
- `POST /github-summary`
- `POST /github-cli/ls`
- `POST /github-cli/cat`
- `POST /github-issues/create`
- `POST /github-issues/update`
- `POST /cli/himalaya/email-list`
- `POST /cli/himalaya/email-read`
- `POST /cli/otter/speeches-list`
- `POST /cli/otter/speech-get`
- `POST /cli/otter/speech-search`
- `POST /cli/github/common`
- `POST /agent-command`

## Caller Allow-List

Set `ALLOWED_CALLER_NUMBERS` to a comma-separated list of E.164 phone numbers that may reach the ElevenLabs agent. Store real personal phone numbers as Worker secrets, not in committed config.

When an inbound caller is not allow-listed, the Worker returns a short TwiML message and does not call ElevenLabs.

## Web Search Tool

`POST /web-search` is a basic authenticated webhook tool for ElevenLabs. It uses DuckDuckGo public endpoints and returns compact search results plus an `answer_text` field for voice responses.

When the query clearly asks for FIFA World Cup soccer schedules or scores, the tool also adds a small structured `sports_events` enrichment from ESPN's public scoreboard endpoint. Treat that as a prototype convenience, not a long-term sports-data contract.

For production-quality search, replace this with a paid search API such as Tavily, Exa, Brave Search, Bing, or Google Programmable Search.

## GitHub Summary Tool

`POST /github-summary` is an authenticated ElevenLabs webhook tool for read-only GitHub issue and pull request summaries. The Worker calls GitHub with `GITHUB_READ_TOKEN`, which must be stored as a Worker secret.

Supported request fields:

- `item_type`: `issues` or `pull_requests`
- `scope`: `involved`, `assigned`, `authored`, `mentioned`, or `review_requested`
- `repo`: optional `owner/name` repository filter
- `organization`: optional organization login filter
- `owner`: optional owner login filter
- `max_results`: 1 to 8

The response includes `total_count`, compact `items`, and a voice-friendly `answer_text`.

## Twilio Diagnostics

The Worker injects a Twilio Media Streams `statusCallback` into the ElevenLabs `<Stream>` TwiML. Twilio then posts `stream-started`, `stream-stopped`, and `stream-error` events to `POST /twilio/stream-status`.

The Twilio phone number can also send broader call lifecycle callbacks to `POST /twilio/call-status`.

When `TWILIO_EVENT_LOGS` is bound, recent events are stored in KV and can be read from `GET /twilio/events` with either the Twilio webhook token query parameter or the tool bearer token. Use `call_sid` to filter a specific call.

## GitHub CLI-Style Read Tools

`POST /github-cli/ls` and `POST /github-cli/cat` are authenticated ElevenLabs webhook tools for read-only repository inspection.

`/github-cli/ls` supports:

- `repo`: required `owner/name` repository
- `path`: optional repository-relative directory path
- `ref`: optional branch, tag, or commit SHA
- `recursive`: optional boolean for recursive tree reads
- `max_entries`: optional response cap

`/github-cli/cat` supports:

- `repo`: required `owner/name` repository
- `path`: required repository-relative file path
- `ref`: optional branch, tag, or commit SHA
- `max_bytes`: optional file content cap

The responses include a `gh_equivalent` field showing the closest GitHub CLI command, but the Worker does not execute shell commands.

## GitHub Issue Write Tools

`POST /github-issues/create` and `POST /github-issues/update` are authenticated ElevenLabs webhook tools for issue-only writes.

Both require `confirmed=true`, which the agent prompt reserves for after Andrew has verbally confirmed the exact change. Store the write-capable token as `GITHUB_WRITE_TOKEN`, preferably using a fine-grained token scoped only to selected repositories and issue permissions.

The write tools can create and update issues. They cannot merge, approve, push code, or edit repository files.

## CLI Bridge Tools

The `/cli/*` endpoints are authenticated ElevenLabs webhook tools, but the Worker does not run local binaries. It validates the public tool bearer token and proxies those requests to `CLI_BRIDGE_URL` using `CLI_BRIDGE_TOKEN`.

Supported bridge-backed tools:

- Himalaya: email envelope list/search and preview read.
- Otter: transcript list, raw JSON fetch, and transcript search.
- GitHub CLI: common read-only repo, issue, PR, and search commands.

If `CLI_BRIDGE_URL` or `CLI_BRIDGE_TOKEN` is unset, these endpoints return `cli_bridge_not_configured`. See `docs/CLI_BRIDGE_SECURITY.md` before deploying a bridge with real email/Otter/GitHub credentials.
