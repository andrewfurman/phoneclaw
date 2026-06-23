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
wrangler secret put VISUALIZER_PASSWORD
# Optional: separate session-signing secret for the visualizer cookie.
wrangler secret put VISUALIZER_SESSION_SECRET
# Optional Tavily search backend.
wrangler secret put TAVILY_API_KEY
wrangler secret put CLI_BRIDGE_URL
wrangler secret put CLI_BRIDGE_TOKEN
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
- `POST /cli/himalaya/email-archive`
- `POST /cli/himalaya/draft-create`
- `POST /cli/himalaya/draft-reply`
- `POST /cli/himalaya/email-forward`
- `POST /cli/himalaya/create-reply-all-draft`
- `POST /cli/himalaya/create-forward-draft`
- `POST /cli/himalaya/email-send`
- `POST /cli/otter/speeches-list`
- `POST /cli/otter/speech-get`
- `POST /cli/otter/speech-search`
- `POST /cli/github/common`
- `POST /cli/rss/economist/recent`
- `POST /cli/rss/economist/search`
- `POST /cli/rss/economist/article-text`
- `POST /cli/rss/economist/refresh`
- `POST /cli/rss/feeds`
- `POST /cli/rss/recent`
- `POST /cli/rss/search`
- `POST /cli/rss/article-text`
- `POST /cli/rss/refresh`
- `POST /cli/claude-code`
- `POST /conversation-history/search`
- `POST /conversation-history/get`
- `POST /conversation-history/recent-context`
- `POST /conversation-history/archive-elevenlabs`
- `POST /agent-command`
- `GET /visualizer`
- `GET /visualizer/api/bootstrap`
- `GET /visualizer/api/conversations/:conversation_id`
- `POST /visualizer/api/archive-latest`

## Caller Allow-List

Set `ALLOWED_CALLER_NUMBERS` to a comma-separated list of E.164 phone numbers that may reach the ElevenLabs agent. Store real personal phone numbers as Worker secrets, not in committed config.

When an inbound caller is not allow-listed, the Worker returns a short TwiML message and does not call ElevenLabs.

## Web Search Tool

`POST /web-search` is a basic authenticated webhook tool for ElevenLabs. It returns compact search results plus an `answer_text` field for voice responses.

By default it uses Tavily when `TAVILY_API_KEY` is configured and falls back to DuckDuckGo public endpoints when no key is present. Use `WEB_SEARCH_PROVIDER=auto` for this behavior, or `WEB_SEARCH_PROVIDER=tavily` to require Tavily once the secret exists. `TAVILY_SEARCH_DEPTH` can be set to `ultra-fast`, `fast`, `basic`, or `advanced`; `fast` is the default for phone-call latency.

When the query clearly asks for FIFA World Cup soccer schedules or scores, the tool also adds a small structured `sports_events` enrichment from ESPN's public scoreboard endpoint. Treat that as a prototype convenience, not a long-term sports-data contract.

For other production-quality search backends, add another provider behind the same response shape.

## GitHub Summary Tool

`POST /github-summary` is an authenticated ElevenLabs webhook tool for read-only GitHub issue and pull request summaries. The Worker validates the public tool bearer token, then proxies the request to the private CLI bridge. The bridge calls GitHub through its authenticated `gh` session.

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

When `AUTO_ARCHIVE_CONVERSATIONS_ON_CALL_END` is unset or true, terminal Twilio call status callbacks best-effort trigger the bridge's conversation archive endpoint. Keep the EC2 systemd timer enabled as the retry backstop for ElevenLabs transcript finalization lag.

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

The responses include a `gh_equivalent` field showing the closest GitHub CLI command. The Worker does not execute shell commands; the private bridge executes fixed `gh` commands with `execFile`.

## GitHub Issue Write Tools

`POST /github-issues/create` and `POST /github-issues/update` are authenticated ElevenLabs webhook tools for issue-only writes.

Both require `confirmed=true`, which the agent prompt reserves for after Andrew has verbally confirmed the exact change. Writes use the same authenticated `gh` session on the private bridge, so keep that service-user GitHub authorization as narrow as the product requirements allow.

The write tools can create and update issues. They cannot merge, approve, push code, or edit repository files.

## CLI Bridge Tools

The `/cli/*` endpoints are authenticated ElevenLabs webhook tools, but the Worker does not run local binaries. It validates the public tool bearer token and proxies those requests to `CLI_BRIDGE_URL` using `CLI_BRIDGE_TOKEN`.

Supported bridge-backed tools:

- Himalaya: email envelope list/search, all-pages capped listing/count, preview read, confirmed archive, confirmed new draft, confirmed reply-all draft with inline original thread, confirmed forward draft with inline original HTML when available and no `.eml` attachment, and emergency-only confirmed send.
- Otter: transcript list, raw JSON fetch, and transcript search.
- GitHub CLI: common read-only repo, issue, PR, and search commands.
- RSS: configured public/private RSS feed listing, recent entries, keyword/date search, article text from feed content fields, and bridge cache refresh. Article-text responses include `access_note` when the feed appears to provide only an excerpt.
- Claude Code: auth status, session start, confirmed async task submission, and job status.

The Himalaya write tools and Claude Code task submission require `confirmed=true`. Ordinary email composition and forwarding should use draft tools. The send path is isolated in `himalaya_email_send` and additionally requires `emergency=true`, `previewed=true`, and `confirmed=true`.

If `CLI_BRIDGE_URL` or `CLI_BRIDGE_TOKEN` is unset, these endpoints return `cli_bridge_not_configured`. See `docs/CLI_BRIDGE_SECURITY.md` before deploying a bridge with real email/Otter/GitHub/Claude Code credentials.

## Live Conversation Visualizer

`GET /visualizer` serves a password-protected React Router dashboard from the same Worker. The dashboard shows recent ElevenLabs conversations, archived Neon conversation summaries, transcript turns, tool calls/results, recent Twilio stream/call events, and action links extracted from tool outputs.

The production Worker also has a visualizer-only custom domain at `phoneclaw.aifurman.com`; its root path redirects to `/visualizer/`.

Set `VISUALIZER_PASSWORD` as a Worker secret. Do not commit the real password to `wrangler.toml`. The Worker sets a signed, HttpOnly session cookie after login; the browser never receives `CLI_BRIDGE_TOKEN` or `ELEVENLABS_API_KEY`.

Build the embedded Worker assets before deploy:

```bash
npm run visualizer:build
npm run worker:deploy
```

After deploy, validate the password gate and API with:

```bash
VISUALIZER_PASSWORD='<local test password>' npm run visualizer:test
```

For a live demo validation, run `npm run visualizer:demo-test`. It starts an ElevenLabs text conversation that exercises Economist RSS, Gmail draft creation, and GitHub issue creation, then reports the resulting conversation id and links. Use that id with `VISUALIZER_CONVERSATION_ID=<id> npm run visualizer:screenshots` to capture desktop and mobile visual QA screenshots.
