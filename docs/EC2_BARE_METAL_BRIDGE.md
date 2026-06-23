# EC2 Bare-Metal CLI Bridge

The long-running CLI bridge can run directly on an EC2 VM without Docker.

## Architecture

```text
Twilio -> ElevenLabs -> Cloudflare Worker -> Cloudflare Tunnel -> EC2 Fastify bridge
```

The EC2 instance runs:

- `phoneclaw-bridge.service`: Fastify app bound to `127.0.0.1:8000`.
- `phoneclaw-cloudflared.service`: Cloudflare Tunnel connector.
- CLI tools under the `phoneclaw` service user:
  - `himalaya`
  - `otter`
  - `gh`
  - `aws`
  - `railway`
  - `vercel`
  - `wrangler`
  - `claude`

The Fastify port is not opened to the internet. Cloudflare Tunnel publishes the bridge hostname and forwards traffic to localhost on the VM.

## Provisioning

Use `deploy/ec2-user-data.sh` as EC2 user data when launching an Ubuntu 24.04 instance.

Recommended baseline:

- Ubuntu 24.04 LTS, x86_64.
- `t3.small` or larger.
- 20 GB encrypted gp3 root volume.
- Security group with SSH restricted to Andrew's current IP only.
- No inbound HTTP/HTTPS ports.
- UFW enabled with default deny incoming, allow outgoing, and SSH restricted to Andrew's current IP only.

## Secrets

Do not commit any of these:

- AWS access keys.
- SSH private keys.
- Cloudflare tunnel token.
- `CLI_BRIDGE_TOKEN`.
- `GH_TOKEN`.
- Himalaya config.
- Otter config.
- Miniflux API token for private RSS/article access.
- Claude Code auth files or Anthropic API keys.

Runtime secrets live on the host:

- `/etc/phoneclaw/bridge.env`
- `/etc/cloudflared/phoneclaw.env`
- `/home/phoneclaw/.config/himalaya/config.toml`
- `/home/phoneclaw/.otterai/config.json`
- `/home/phoneclaw/.claude/` or `ANTHROPIC_API_KEY` in `/etc/phoneclaw/bridge.env`
- `/home/phoneclaw/.aws/`
- `/var/lib/phoneclaw/claude-jobs/`

Common bridge environment settings include:

```text
HIMALAYA_SEND_TIMEOUT_MS=8000
```

For the Gmail-backed Himalaya account, configure Gmail's real folder aliases and avoid the extra sent-copy save:

```toml
folder.aliases.inbox = "INBOX"
folder.aliases.sent = "[Gmail]/Sent Mail"
folder.aliases.drafts = "[Gmail]/Drafts"
folder.aliases.trash = "[Gmail]/Trash"
message.send.save-copy = false
```

Phoneclaw sends raw emergency messages to `himalaya message send` through stdin. Passing raw MIME as a positional argument can trigger a Himalaya/mail-parser panic, and Gmail SMTP already stores sent mail, so `message.send.save-copy = false` avoids both parser and sent-copy failures.

## Services

Check status:

```bash
sudo systemctl status phoneclaw-bridge
sudo systemctl status phoneclaw-cloudflared
```

Restart after config changes:

```bash
sudo systemctl restart phoneclaw-bridge
sudo systemctl restart phoneclaw-cloudflared
```

View logs:

```bash
journalctl -u phoneclaw-bridge -f
journalctl -u phoneclaw-cloudflared -f
```

## Worker Settings

The Worker needs:

```text
CLI_BRIDGE_URL=https://cli-bridge.aifurman.com
CLI_BRIDGE_TOKEN=<same token as /etc/phoneclaw/bridge.env>
```

The Worker validates the ElevenLabs tool bearer token first, then forwards bridge calls to EC2 with `CLI_BRIDGE_TOKEN`.

## Current Validation

Validation should cover:

- `GET https://cli-bridge.aifurman.com/health`
- Worker proxy call to `/cli/himalaya/email-list`
- Worker proxy call to `/cli/himalaya/email-send` validation path; SMTP timeouts should return an explicit unconfirmed-send result within `HIMALAYA_SEND_TIMEOUT_MS`, not a gateway timeout.
- Worker proxy call to `/cli/otter/speeches-list`
- Worker proxy call to `/cli/otter/speech-get`
- Worker proxy call to `/cli/github/common`
- Worker proxy call to `/cli/claude-code` with `{"action":"auth_status"}`
- ElevenLabs WebSocket conversation using `otter_speeches_list` and `himalaya_email_list`

## Claude Code

Install Claude Code on the bridge host and authenticate it as the `phoneclaw` service user:

```bash
sudo npm install -g @anthropic-ai/claude-code
sudo -iu phoneclaw claude auth login
```

Alternatively, store an Anthropic API key in `/etc/phoneclaw/bridge.env`:

```text
ANTHROPIC_API_KEY=...
CLAUDE_BIN=claude
CLAUDE_CODE_JOB_DIR=/var/lib/phoneclaw/claude-jobs
CLAUDE_CODE_STEERING_DIR=/var/lib/phoneclaw/claude-steering
CLAUDE_CODE_ALLOWED_DIRS=/opt/phoneclaw
CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS=true
CLAUDE_CODE_PERMISSION_MODE=bypassPermissions
AWS_PROFILE=phoneclaw-personal
```

The `claude_code` voice tool is intentionally explicit. It can check auth, create a session id, submit a confirmed async job, append confirmed steering instructions to an existing session or job, and poll job status. It should not be used as the default path for ordinary questions.

Steering instructions are stored as session-scoped JSONL records under `CLAUDE_CODE_STEERING_DIR`. When a job starts, the bridge includes that file path in the Claude Code prompt and instructs Claude to re-read it before planning, editing, verification, and final response. This gives Andrew a way to keep shaping an active Claude Code session from the phone agent instead of submitting a task once and losing the thread.

Run-mode jobs use Claude Code `bypassPermissions` plus `--dangerously-skip-permissions` when `CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS=true`, so they do not stall on permission prompts.

## Configured RSS Feeds

Phoneclaw can expose any public or private RSS/Atom feed to the voice agent through generic tools. Store private URLs in a host-local JSON file, not in Git:

```bash
sudo install -d -m 0750 -o phoneclaw -g phoneclaw /etc/phoneclaw
sudo install -m 0640 -o phoneclaw -g phoneclaw /dev/null /etc/phoneclaw/rss-feeds.json
```

Example file shape:

```json
{
  "feeds": [
    {
      "id": "economist",
      "title": "The Economist",
      "url": "https://example.com/rss.xml?token=replace-with-private-token",
      "private": true,
      "cache_seconds": 900
    }
  ]
}
```

Then set the bridge env and restart:

```bash
RSS_FEEDS_CONFIG_PATH=/etc/phoneclaw/rss-feeds.json
RSS_FEEDS_CACHE_SECONDS=900
RSS_FEEDS_TIMEOUT_MS=12000
```

The generic RSS tools fetch feed XML only and cache it on the Phoneclaw bridge. For feeds that already do upstream article scraping, such as the separate full-text Economist feed service, Phoneclaw should not hold publisher credentials or browser state; it only needs the private RSS URL.

## Legacy Miniflux RSS

The live bridge can run Miniflux privately on `127.0.0.1:8080` with PostgreSQL. Store the API token in `/etc/phoneclaw/bridge.env`:

```bash
MINIFLUX_BASE_URL=http://127.0.0.1:8080
MINIFLUX_API_TOKEN=<miniflux-api-token>
MINIFLUX_ECONOMIST_CATEGORY_TITLE=Economist
ECONOMIST_RSS_BRIDGE_URL=https://cli-bridge.aifurman.com/rss/economist/latest.atom
ECONOMIST_RSS_BRIDGE_TOKEN=<rss-bridge-token>
ECONOMIST_PUBLIC_RSS_TOKEN=<rss-bridge-token>
ECONOMIST_RSS_BRIDGE_BASE_URL=http://127.0.0.1:3000/
ECONOMIST_PUBLIC_RSS_ALLOWED_TOPICS=latest
ECONOMIST_PUBLIC_RSS_MAX_ENTRIES=10
ECONOMIST_PUBLIC_RSS_CACHE_SECONDS=900
ECONOMIST_BROWSER_FETCH_ENABLED=true
ECONOMIST_BROWSER_STORAGE_STATE=/var/lib/phoneclaw/economist-browser-state.json
ECONOMIST_BROWSER_USER_DATA_DIR=/var/lib/phoneclaw/economist-browser-profile
ECONOMIST_BROWSER_HEADLESS=true
```

After Miniflux is running, bootstrap Economist feeds:

```bash
cd /opt/phoneclaw
npm run miniflux:economist:setup
sudo systemctl restart phoneclaw-bridge
```

Do not store publisher account passwords in the repo or bridge env. If a publisher requires login for full text, prefer Miniflux feed cookies or the locked-down browser-cookie fetcher over raw account credentials.

For The Economist specifically, list/search works from section RSS feeds, but Miniflux original-content fetches can be rejected by the site's Cloudflare challenge. Treat `access_note` on `rss_get_economist_article_text` as authoritative: when it says the returned text is only an excerpt, the bridge needs a separate authenticated fetch path before it can provide subscriber full text.

The live bridge can expose secure RSS-Bridge Atom feeds without publishing RSS-Bridge itself. RSS-Bridge should stay bound to `127.0.0.1`; the Fastify bridge proxies only allow-listed Economist topics such as `latest`, requires a secret token, and clamps the feed limit. For internal article-text lookups on EC2, Phoneclaw can also use `ECONOMIST_RSS_BRIDGE_BASE_URL` directly and infer the section topic from an Economist article URL before falling back to the latest feed.

RSS-Bridge's Economist cookie is operationally sensitive. When the publisher returns a Cloudflare `403 Forbidden` placeholder, Phoneclaw reports `rss_bridge_article_fetch_failed` instead of treating that placeholder as full text. Refresh the RSS-Bridge cookie or browser profile before expecting full subscriber text again.

The browser fallback uses Playwright/Chromium on the EC2 host. It should run as the `phoneclaw` service user with browser state under `/var/lib/phoneclaw/`, so cookies are readable only by the bridge service. The tool still returns `access_note` when the browser profile is not logged in, is challenged, or only sees an excerpt.

## Conversation Memory

The bridge has config-gated Postgres support for archived phone conversations. Set `CONVERSATION_DATABASE_URL` in `/etc/phoneclaw/bridge.env`, restart `phoneclaw-bridge`, then backfill recent calls:

```bash
cd /opt/phoneclaw
npm run conversations:archive
```

For automatic post-call logging, install the timer units from the repo:

```bash
sudo cp deploy/phoneclaw-conversation-archive.service /etc/systemd/system/
sudo cp deploy/phoneclaw-conversation-archive.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now phoneclaw-conversation-archive.timer
```

The Worker also best-effort triggers `conversation-history/archive-elevenlabs` when Twilio reports a terminal call status. The timer is the retry backstop so late ElevenLabs transcripts are still archived.

If the database URL is missing, conversation-history endpoints return `conversation_history_not_configured` with HTTP 200 so the voice agent can explain the missing setup without treating it as a transport failure.
