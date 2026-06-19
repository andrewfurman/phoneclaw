#!/usr/bin/env bash
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y \
  build-essential \
  ca-certificates \
  curl \
  git \
  gnupg \
  jq \
  libssl-dev \
  pkg-config \
  unzip

install -d -m 0755 /etc/apt/keyrings

curl -fsSL https://deb.nodesource.com/setup_22.x | bash -

curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  -o /usr/share/keyrings/cloudflare-main.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
  > /etc/apt/sources.list.d/cloudflared.list

curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list

apt-get update
apt-get install -y nodejs cloudflared gh

if ! id phoneclaw >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash phoneclaw
fi

install -d -m 0755 /opt
if [ ! -d /opt/phoneclaw/.git ]; then
  git clone --depth 1 https://github.com/andrewfurman/phoneclaw.git /opt/phoneclaw
else
  git -C /opt/phoneclaw pull --ff-only
fi
chown -R phoneclaw:phoneclaw /opt/phoneclaw

sudo -u phoneclaw bash -lc 'cd /opt/phoneclaw && npm ci --omit=dev'

install -d -m 0750 -o root -g phoneclaw /etc/phoneclaw
if [ ! -f /etc/phoneclaw/bridge.env ]; then
  cat > /etc/phoneclaw/bridge.env <<'ENV'
HOST=127.0.0.1
PORT=8000
CLI_BRIDGE_TOKEN=replace-me
HIMALAYA_BIN=/home/phoneclaw/.cargo/bin/himalaya
OTTER_BIN=/home/phoneclaw/.cargo/bin/otter
GH_BIN=/usr/bin/gh
HIMALAYA_ARCHIVE_FOLDER="[Gmail]/All Mail"
HIMALAYA_DRAFTS_FOLDER="[Gmail]/Drafts"
ENV
fi
chown root:phoneclaw /etc/phoneclaw/bridge.env
chmod 0640 /etc/phoneclaw/bridge.env

cat > /etc/systemd/system/phoneclaw-bridge.service <<'SERVICE'
[Unit]
Description=Phoneclaw Fastify CLI bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=phoneclaw
Group=phoneclaw
WorkingDirectory=/opt/phoneclaw
EnvironmentFile=/etc/phoneclaw/bridge.env
ExecStart=/usr/bin/node fastify-app/server.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable phoneclaw-bridge

sudo -u phoneclaw bash -lc '
  if [ ! -x "$HOME/.cargo/bin/cargo" ]; then
    curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
  fi
  . "$HOME/.cargo/env"
  cargo install himalaya --locked || cargo install himalaya
  cargo install --git https://github.com/andrewfurman/otter-ai-cli --locked || cargo install --git https://github.com/andrewfurman/otter-ai-cli
'

systemctl start phoneclaw-bridge || true
