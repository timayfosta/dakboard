# Deploy & HTTPS

Family Board runs on the Raspberry Pi at `http://<pi-ip>:8765`. Lists, chores, rewards, and star balances all live in `data/family.json` on the Pi — no Google Tasks needed.

## Pi kiosk

```bash
sudo bash scripts/pi/install-kiosk.sh
```

This installs two **systemd** services that start automatically on boot:

| Service | Starts | Role |
|---------|--------|------|
| `family-board-api` | At multi-user (network up) | Python API on port 8765 |
| `family-board-kiosk` | After desktop + API | Full-screen Chromium carousel |

The kiosk waits up to 90 seconds for the API health check before opening the browser.

**Useful commands**

```bash
systemctl status family-board-api family-board-kiosk
journalctl -u family-board-api -f
journalctl -u family-board-kiosk -f
sudo systemctl restart family-board-api family-board-kiosk
```

### After a manual git reset — kiosk or rotation stopped working

If you ran `git reset --hard` by hand, systemd may still point at an old folder (e.g. `/home/pi/family-board` while the repo is now `~/dakboard`). Symptoms: API/kiosk do not start on boot, portrait rotation missing, screen carousel stuck on one page.

From **inside your git checkout** on the Pi:

```bash
cd ~/dakboard          # or ~/family-board — wherever server.py lives
sudo bash scripts/pi/repair-kiosk.sh
sudo reboot
```

Check status:

```bash
systemctl status family-board-api family-board-kiosk
journalctl -u family-board-api -u family-board-kiosk -b --no-pager
```

**Pi desktop:** enable auto-login to the desktop (Raspberry Pi OS → raspi-config → System Options → Boot / Auto Login → Desktop) so the graphical kiosk service can run.

Kiosk opens the first screen in `shared/screens.js` with `?kiosk=1`:

- Swipe left/right (or tap the bottom dots) to change screens
- Auto-rotates every 45 seconds (configurable in `shared/screens.js`)
- Touch anywhere to pause rotation for 2 minutes

**Add a new screen:** create `screens/your-screen.html`, then add an entry to `FAMILY_SCREENS.screens` in `shared/screens.js` with `enabled: true`.

The **Family Whiteboard** (`screens/whiteboard.html`) saves drawings to the Pi and syncs across displays. Open it from the kiosk carousel (📝 Board dot).

**Display sizing:** Layout is designed at 1080×1920 portrait (`shared/config.js` → `display`). It auto-scales to fit any monitor — portrait TV fills edge-to-edge; landscape dev monitors get black pillarboxing, not a stretched horizontal layout.

## Auto-deploy on git push

Pushing to GitHub does **not** update phones/TVs by itself. The Pi must pull + restart, then open clients auto-reload.

**Flow after this is configured:**

1. You push to `main` / `master`
2. GitHub Actions (or webhook) runs `scripts/git_sync.sh` + restarts `family-board-api` and `family-board-kiosk`
3. Admin PWA + TV screens notice the new `bootId` from `/api/health` and **reload themselves** (within a few seconds)

The Pi must be a **git clone** (not rsync-only) for pull-to-update:

```bash
git clone https://github.com/YOU/dakboard.git ~/family-board
cd ~/family-board
sudo bash scripts/pi/install-kiosk.sh
```

### Option A — GitHub Actions (recommended for home Pi)

Works without exposing the Pi to the internet. Add repository secrets:

| Secret | Value |
|--------|--------|
| `PI_HOST` | Pi IP or Tailscale hostname |
| `PI_USER` | `pi` |
| `PI_SSH_KEY` | Private SSH key that can SSH into the Pi |

On push to `main`/`master` (or manual **Actions → Deploy to Pi → Run workflow**), the job SSHs in and runs `scripts/deploy_update.sh`.

Check: GitHub → **Actions** → latest “Deploy to Pi” run should be green.

### Option B — GitHub webhook

If the Pi is reachable (port forward, Tailscale Funnel, or Cloudflare Tunnel):

Add to `shared/secrets.local.js` on the Pi:

```js
deployWebhookSecret: "pick-a-long-random-string",
deployBranch: "main",   // optional — defaults to main
```

1. GitHub repo → **Settings → Webhooks → Add**
2. URL: `https://<your-tunnel>/api/webhooks/github` (or `http://<pi-ip>:8765/api/webhooks/github`)
3. Content type: `application/json`
4. Secret: same as `deployWebhookSecret`
5. Events: **Just the push event**

Push to `main`/`master` triggers a forced sync to origin (`git reset --hard`, no merge) and a server restart. Open admin/TV tabs then auto-refresh.

Generic webhook (same secret): `POST /api/webhooks/deploy` with header `X-Deploy-Token: <secret>`.

### Manual deploy

- **Admin → More → Pull updates & restart now**
- Or on the Pi: `bash scripts/deploy_update.sh`

Deploy **never merges** — it runs `scripts/git_sync.sh`, which fetches origin and `git reset --hard` to match GitHub exactly. Local edits to tracked files on the Pi are discarded (runtime data in `data/` is gitignored and kept).

### "Changes would be overwritten by merge"

That message means the Pi is still running **old deploy code** that used `git pull`. Fix once over SSH:

```bash
cd ~/dakboard   # or ~/family-board
git fetch origin
git merge --abort 2>/dev/null || true
git reset --hard origin/master   # or origin/main
sudo systemctl restart family-board-api
```

After you push the latest code, admin deploy and GitHub Actions use `git_sync.sh` and this error should not recur.

After restart, leave admin/TV pages open — they should refresh on their own.

## Admin PWA on your phone (HTTPS)

Browsers require HTTPS to install a PWA from another device. Options:

### Option A — Cloudflare Tunnel (recommended for home)

1. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) on the Pi
2. Run: `cloudflared tunnel --url http://127.0.0.1:8765`
3. Open the `*.trycloudflare.com` URL on your phone → **`/phone/index.html`** (not `/admin/`) → Add to Home Screen

   Example: `https://your-tunnel.trycloudflare.com/phone/index.html`

   Use **`trycloudflare.com`** (one “l” in cloudflare). Avoid `/phone` ↔ `/phone/` — Cloudflare can redirect-loop on trailing slashes; `/phone/index.html` is safest.

   LAN access still works at `/admin/`.

   If `/phone/` returns 404 on the Pi, run once:

   ```bash
   cd ~/family-board
   bash scripts/pi/link-phone-admin.sh
   sudo systemctl restart family-board-api
   curl -s -o /dev/null -w "phone: %{http_code}\n" http://127.0.0.1:8765/phone/
   ```

   You should see `phone: 200` before trying the tunnel again.

For a permanent hostname, create a named tunnel in the Cloudflare Zero Trust dashboard.

### Option B — Local network only

On the same Wi‑Fi, open `http://<pi-ip>:8765/admin/` in Safari/Chrome. You can use the admin UI without installing; PWA install may be blocked without HTTPS.

## Private Google Calendar (optional Cloudflare Worker)

If the Pi is not reachable from the internet but you want calendar sync via Cloudflare:

```bash
npm install -g wrangler   # or use npx wrangler
wrangler login
wrangler secret put ICS_URL   # paste secret iCal URL from Google Calendar
wrangler deploy
```

Set `googleCalendar.proxyUrl` in `shared/config.js` to your worker URL. The Pi can also proxy calendar locally via `/api/calendar` when `icsUrl` is in `shared/secrets.local.js` (no Cloudflare required on LAN).
