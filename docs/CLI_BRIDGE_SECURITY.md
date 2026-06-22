# CLI Bridge Security

Phoneclaw exposes public ElevenLabs webhook tools through the Cloudflare Worker. A normal Worker cannot run local binaries such as `himalaya`, `otter`, or `gh`, and it should not store copied CLI credential files from a laptop.

## Recommended Shape

Use two layers:

1. Public Cloudflare Worker at `https://webhooks.aifurman.com`.
2. Private Fastify CLI bridge running on a VM/container that has the CLIs installed and authenticated.

The Worker validates the ElevenLabs tool bearer token, then proxies CLI calls to the private bridge with a separate `CLI_BRIDGE_TOKEN`.

## Credential Placement

Do not commit or log these files:

- `~/.config/himalaya`
- `~/.otterai`
- `~/.config/gh`
- `~/.claude`
- system keychain exports
- `.env`

For the bridge host, authenticate each CLI under a restricted service user:

- `himalaya account configure` or copy a minimal Himalaya config through an encrypted secret channel.
- `otter login` on the host, or copy only the required Otter config through an encrypted secret channel.
- `gh auth login` as the service user, with only the scopes and organization approvals required for the repositories the assistant should access.
- `claude auth login` as the service user, or an Anthropic API key in the bridge env.

Prefer a VM/container secret manager over baking credentials into an image.

## Required Environment

On the Worker:

```text
WEB_SEARCH_TOKEN=...
CLI_BRIDGE_URL=https://private-cli-bridge.example.com
CLI_BRIDGE_TOKEN=...
```

On the Fastify bridge:

```text
CLI_BRIDGE_TOKEN=...
HIMALAYA_BIN=himalaya
HIMALAYA_SEND_TIMEOUT_MS=8000
OTTER_BIN=otter
GH_BIN=gh
GITHUB_USERNAME=andrewfurman
CLAUDE_BIN=claude
CLAUDE_CODE_JOB_DIR=/var/lib/phoneclaw/claude-jobs
CLAUDE_CODE_ALLOWED_DIRS=/opt/phoneclaw
CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS=true
AWS_PROFILE=phoneclaw-personal
CONVERSATION_DATABASE_URL=postgres://...
```

For local development only, the bridge can fall back to `WEB_SEARCH_TOKEN` if `CLI_BRIDGE_TOKEN` is unset. Production should set `CLI_BRIDGE_TOKEN`.

## Lockdown Checklist

- Keep the bridge off the public internet when possible. Put it behind a Cloudflare Tunnel, private network, or firewall rule that only allows Cloudflare egress.
- Use a long random `CLI_BRIDGE_TOKEN` that is different from `WEB_SEARCH_TOKEN`.
- Run the bridge as a non-admin service user with only the CLI config files it needs.
- Keep CLI tools read-only by default. Any write tool must be narrowly scoped and confirmation-gated. Email archive/draft tools cannot send mail; `himalaya_email_forward` saves a draft only and does not send the forwarded message. Emergency sends are isolated in `himalaya_email_send` and require `emergency=true`, an exact verbal preview, and a second confirmation. The emergency send path should use a short `HIMALAYA_SEND_TIMEOUT_MS` so SMTP hangs fail with an explicit unconfirmed-send result instead of tying up a voice turn. Claude Code task submission is also confirmation-gated and runs asynchronously.
- For Gmail-backed emergency sends, set Himalaya `message.send.save-copy = false` and point `folder.aliases.sent` at `[Gmail]/Sent Mail`. Gmail SMTP stores sent mail automatically; the extra IMAP sent-copy step can fail or hang after a successful SMTP send.
- Cap command output and timeouts. The current bridge uses fixed commands, `execFile`, no shell interpolation, timeouts, and raw output truncation.
- Rotate Otter, email, GitHub, and bridge tokens if they are ever pasted into chat, logs, or a public issue.

## Current EC2 Hardening

The live bridge host is configured so the Fastify service listens on `127.0.0.1:8000`, not a public interface. Cloudflare Tunnel is the public ingress path for bridge traffic, and the bridge still requires `CLI_BRIDGE_TOKEN` on every CLI/Claude/conversation-history request.

Inbound network access is restricted at two layers:

- AWS security group: SSH only from Andrew's current public IP.
- UFW on the instance: default deny incoming, allow outgoing, SSH only from Andrew's current public IP.

There are no public inbound HTTP or HTTPS ports for the Fastify bridge.

Claude Code run jobs are intentionally configured with `CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS=true` on this host so confirmed jobs do not hang on permission prompts. That setting is acceptable only because tool access is behind the Worker, Cloudflare Tunnel, bearer-token bridge auth, an allow-listed working directory, and explicit voice confirmation before task submission.

## Why Not Put CLI Credentials Into A Worker?

Workers are good for request routing, auth checks, and API calls. They are not a good fit for these CLI tools because they cannot spawn local processes or rely on a local keyring/home directory. Copying laptop CLI state into Worker secrets would also make credential rotation and auditing harder.
