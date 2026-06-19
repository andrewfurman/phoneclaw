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
- system keychain exports
- `.env`

For the bridge host, authenticate each CLI under a restricted service user:

- `himalaya account configure` or copy a minimal Himalaya config through an encrypted secret channel.
- `otter login` on the host, or copy only the required Otter config through an encrypted secret channel.
- `gh auth login` or `GH_TOKEN` with the least scopes required.

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
OTTER_BIN=otter
GH_BIN=gh
```

For local development only, the bridge can fall back to `WEB_SEARCH_TOKEN` if `CLI_BRIDGE_TOKEN` is unset. Production should set `CLI_BRIDGE_TOKEN`.

## Lockdown Checklist

- Keep the bridge off the public internet when possible. Put it behind a Cloudflare Tunnel, private network, or firewall rule that only allows Cloudflare egress.
- Use a long random `CLI_BRIDGE_TOKEN` that is different from `WEB_SEARCH_TOKEN`.
- Run the bridge as a non-admin service user with only the CLI config files it needs.
- Keep CLI tools read-only from ElevenLabs unless a separate confirmation-gated write tool is intentionally added.
- Cap command output and timeouts. The current bridge uses fixed commands, `execFile`, no shell interpolation, timeouts, and raw output truncation.
- Rotate Otter, email, GitHub, and bridge tokens if they are ever pasted into chat, logs, or a public issue.

## Why Not Put CLI Credentials Into A Worker?

Workers are good for request routing, auth checks, and API calls. They are not a good fit for these CLI tools because they cannot spawn local processes or rely on a local keyring/home directory. Copying laptop CLI state into Worker secrets would also make credential rotation and auditing harder.
