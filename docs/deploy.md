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

**Pi desktop:** enable auto-login to the desktop (Raspberry Pi OS → raspi-config → System Options → Boot / Auto Login → Desktop) so the graphical kiosk service can run.

Kiosk opens the first screen in `shared/screens.js` with `?kiosk=1`:

- Swipe left/right (or tap the bottom dots) to change screens
- Auto-rotates every 45 seconds (configurable in `shared/screens.js`)
- Touch anywhere to pause rotation for 2 minutes

**Add a new screen:** create `screens/your-screen.html`, then add an entry to `FAMILY_SCREENS.screens` in `shared/screens.js` with `enabled: true`.

The **Family Whiteboard** (`screens/whiteboard.html`) saves drawings to the Pi and syncs across displays. Open it from the kiosk carousel (📝 Board dot).

**Display sizing:** Layout is designed at 1080×1920 portrait (`shared/config.js` → `display`). It auto-scales to fit any monitor — portrait TV fills edge-to-edge; landscape dev monitors get black pillarboxing, not a stretched horizontal layout.

## Admin PWA on your phone (HTTPS)

Browsers require HTTPS to install a PWA from another device. Options:

### Option A — Cloudflare Tunnel (recommended for home)

1. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) on the Pi
2. Run: `cloudflared tunnel --url http://127.0.0.1:8765`
3. Open the `*.trycloudflare.com` URL on your phone → **`/phone/`** (not `/admin/` — quick tunnels often block paths containing `admin`) → Add to Home Screen

   Example: `https://your-tunnel.trycloudflare.com/phone/`

   LAN access still works at `/admin/`.

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
