# Deploying to a Vultr Ubuntu 24.04 VM

One Node process (`deploy/server.ts`, managed by pm2) serves the built `dist/` and the `/api` routes on
`127.0.0.1:3000`. Caddy sits in front on 80/443 and gets HTTPS certificates automatically. The camera
and microphone only work over HTTPS. The glasses relay is off unless you set `GLASSES_RELAY=on`.

Below, replace `your-domain.example` with your domain. Before you start, create a DNS **A record** for it
that points at the VM's public IPv4 address (Caddy can't get a certificate until it resolves).

## 1. System packages (as root, or prefix with sudo)

```bash
apt update && apt upgrade -y
apt install -y git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https ufw

# Node 20 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v   # v20.x

# Caddy (official apt repo)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

# pm2
npm install -g pm2
```

## 2. Firewall

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status
```

Port 3000 stays closed: the app listens on 127.0.0.1 only.

## 3. App user, code and secrets

```bash
adduser --disabled-password --gecos "" reality
su - reality
git clone https://github.com/rahul-does-code/reality.git ~/reality
cd ~/reality
```

Create `.env` with the variable names below and fill in your values in an editor (`nano .env`).
**Never commit it**; it is already in `.gitignore`.

```bash
cat > .env <<'EOF'
# Required
GEMINI_API_KEY=
META_API_KEY=

# Command parsing: auto (Gemini, then Muse Spark on failure) | gemini | meta
COMMAND_PROVIDER=auto
# Image edits: meta (default) | gemini
IMAGE_PROVIDER=meta

# Optional model overrides (uncomment to override the defaults in server/proxy.ts)
# GEMINI_MODEL=
# GEMINI_THINKING=
# GEMINI_COMMAND_IMAGE_RESOLUTION=
# GEMINI_SEGMENT_MODEL=
# GEMINI_SEGMENT_MASKS=
# GEMINI_SEGMENT_THINKING=
# GEMINI_IMAGE_MODEL=
# META_TEXT_MODEL=
# META_REASONING_EFFORT=
# META_REASONING=
# META_WEB_SEARCH=
# META_IMAGE_SEARCH=
# META_SHELL=
# META_IMAGE_MODEL=
# META_SAM_MODEL=
# META_ASR_MODEL=

# Production server (deploy/server.ts)
PORT=3000
HOST=127.0.0.1
# CORS_ORIGINS=https://other-site.example
RATE_COMMAND_PER_MIN=30
RATE_EDIT_PER_MIN=8
RATE_EDIT_PER_DAY=300
RATE_OTHER_PER_MIN=30
RATE_API_PER_MIN=120

# Glasses relay (off in production; on also needs Caddy + ufw for :8788)
GLASSES_RELAY=off
# GLASSES_RELAY_PORT=8788
EOF
chmod 600 .env
nano .env
```

Leave optional lines commented out: an uncommented empty value (`GEMINI_MODEL=`) replaces the default with an empty string.

## 4. Install, download models, build

```bash
npm ci                     # includes tsx, which runs the server
node scripts/setup.mjs     # MediaPipe WASM + models into public/ (copied into dist/ by the build)
npm run build
```

`npm run build:prod` runs the last two steps in one go.

## 5. Start with pm2 and survive reboots

```bash
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u reality --hp /home/reality
```

`pm2 startup` prints one `sudo env PATH=... pm2 startup ...` line. Run it **as root** (`exit` back to root first),
then go back with `su - reality` and run `pm2 save` again.

Logs: `pm2 logs reality`. Restart after changes: `pm2 restart reality`.

## 6. Caddy for your domain (as root)

```bash
cp /home/reality/reality/deploy/Caddyfile /etc/caddy/Caddyfile
sed -i 's/your-domain.example/YOUR.DOMAIN.HERE/' /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
journalctl -u caddy -n 50 --no-pager   # look for "certificate obtained successfully"
```

## 7. Verify

- [ ] `curl -s http://127.0.0.1:3000/api/health` on the VM returns `{"ok":true,...}`
- [ ] `curl -s https://your-domain.example/api/health` from your laptop returns the same
- [ ] `curl -sI http://your-domain.example` returns a redirect to `https://`
- [ ] `curl -sI https://your-domain.example/models/hand_landmarker.task` returns `200` (setup.mjs ran before the build)
- [ ] Open `https://your-domain.example`: the padlock shows a valid certificate
- [ ] The browser asks for **camera** permission and the live view appears
- [ ] Voice: the browser asks for **microphone** permission and a command like "make it pink" works
- [ ] `curl -s -X POST https://your-domain.example/api/command -H 'Origin: https://evil.example' -H 'content-type: application/json' -d '{}'` returns 403
- [ ] `pm2 status` shows `reality` online; after `reboot` it comes back by itself

## Updating

```bash
su - reality && cd ~/reality
git pull && npm ci && npm run build:prod && pm2 restart reality
```

## What the production server adds

| Protection | Default | Env |
| --- | --- | --- |
| `/api/command` per IP | 30 / minute | `RATE_COMMAND_PER_MIN` |
| `/api/edit` per IP | 8 / minute | `RATE_EDIT_PER_MIN` |
| `/api/edit` for everyone | 300 / UTC day | `RATE_EDIT_PER_DAY` |
| `/api/transcribe`, `/api/aimask`, `/api/segment-named` per IP | 30 / minute each | `RATE_OTHER_PER_MIN` |
| all of `/api` per IP | 120 / minute | `RATE_API_PER_MIN` |

- When a limit is hit, the response is a 429 with a friendly `error` message and a `Retry-After` header.
- Counters live in memory: they reset when pm2 restarts the app, and the app must stay a single process.
- CORS: only same-origin requests are answered. Requests from other origins get a 403 unless they are
  listed in `CORS_ORIGINS`.
- Key names (`*_API_KEY`, `*_KEY`, `*_SECRET`, `*_TOKEN`) and the actual key values are removed from
  every `/api` error body. Bad JSON, oversized bodies and unexpected errors return a short message,
  never a stack trace.
