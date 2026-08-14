"""
Family Board local server
- Static site + admin PWA
- /api/calendar → private Google iCal
- /api/family/* → chores, lists, rewards, kids (admin + kiosk)
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import mimetypes
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "shared"))

try:
    import db  # noqa: E402
    import deploy  # noqa: E402
    import screensaver_albums  # noqa: E402
except ImportError as exc:
    print(
        "ERROR: failed to import shared/*.py modules.\n"
        f"  Looked in: {ROOT / 'shared'}\n"
        f"  Detail: {exc}\n"
        "  Fix: run from the full Family Board folder (must contain server.py + shared/).\n"
        "  Example:  cd ~/family-board-src && python3 server.py",
        flush=True,
    )
    raise SystemExit(1) from exc

PORT = 8765
CHECK_STYLES = frozenset({"circle", "square", "star", "heart", "diamond"})
API_VERSION = 2
BOOT_ID = uuid.uuid4().hex
STARTED_AT = int(time.time() * 1000)
PHOTOS_DIR = ROOT / "data" / "photos"
SECRETS = ROOT / "shared" / "secrets.local.js"
SESSIONS: dict[str, float] = {}  # token -> expires_at
SESSION_HOURS = 30 * 24


def load_secrets() -> dict[str, str]:
    if not SECRETS.exists():
        return {}
    text = SECRETS.read_text(encoding="utf-8")
    out: dict[str, str] = {}
    for key in (
        "icsUrl",
        "adminPassword",
        "googleClientId",
        "googleClientSecret",
        "googleRefreshToken",
        "deployWebhookSecret",
        "deployBranch",
    ):
        match = re.search(rf'{key}:\s*"([^"]*)"', text)
        if match:
            out[key] = match.group(1)
    return out


def send_json(handler: SimpleHTTPRequestHandler, payload: Any, status: int = 200):
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def read_json(handler: SimpleHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length") or 0)
    raw = handler.rfile.read(length) if length else b"{}"
    try:
        return json.loads(raw.decode("utf-8") or "{}")
    except json.JSONDecodeError:
        return {}


def read_raw_body(handler: SimpleHTTPRequestHandler) -> bytes:
    length = int(handler.headers.get("Content-Length") or 0)
    return handler.rfile.read(length) if length else b""


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def schedule_server_restart(delay_s: float = 0.8) -> None:
    """Spawn restart_server.py after the HTTP response is sent."""
    script = ROOT / "scripts" / "restart_server.py"

    def _run() -> None:
        time.sleep(delay_s)
        kwargs: dict[str, Any] = {"cwd": ROOT, "close_fds": True}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        subprocess.Popen([sys.executable, str(script), "--delayed"], **kwargs)

    threading.Thread(target=_run, daemon=True).start()


def require_admin(handler: SimpleHTTPRequestHandler) -> bool:
    # Home Family Board: admin is open (no password gate).
    # Still accept/refresh a bearer token if the client sends one.
    auth = handler.headers.get("Authorization") or ""
    token = auth.replace("Bearer", "").strip()
    if token:
        SESSIONS[token] = time.time() + SESSION_HOURS * 3600
    return True


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _rewrite_phone_to_admin(self) -> None:
        """Map /phone/* to admin files — Cloudflare quick tunnels often block /admin/* paths."""
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = ("?" + parsed.query) if parsed.query else ""
        # Serve index directly — avoids 301 redirect loops with Cloudflare edge (trailing slash)
        if path in ("/phone", "/phone/"):
            self.path = f"/admin/index.html{query}"
            return
        if path.startswith("/phone/"):
            suffix = path[len("/phone") :]
            self.path = f"/admin{suffix}{query}"

    def end_headers(self):
        if self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        elif (
            self.path.startswith("/admin/")
            or self.path.startswith("/phone/")
            or self.path.startswith("/screens/")
            or self.path.startswith("/shared/")
        ):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_OPTIONS(self):
        if self.path.startswith("/api/"):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.end_headers()
            return
        self.send_error(404)

    def do_GET(self):
        self._rewrite_phone_to_admin()
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"

        if path == "/api/calendar":
            return self.proxy_calendar()
        if path == "/api/health":
            head = deploy.git_head()
            return send_json(
                self,
                {
                    "ok": True,
                    "version": API_VERSION,
                    "bootId": BOOT_ID,
                    "startedAt": STARTED_AT,
                    "git": {
                        "sha": head.get("sha") or "",
                        "branch": head.get("branch") or "",
                    },
                    "deploy": {
                        "gitRepo": deploy.is_git_repo(),
                        "webhookConfigured": bool(load_secrets().get("deployWebhookSecret")),
                        "last": deploy.get_last_result(),
                    },
                    "features": ["settings", "screensaver", "whiteboard", "nightMode", "rotation", "liveReload"],
                },
            )
        if path == "/api/auth/me":
            if not require_admin(self):
                return
            return send_json(self, {"ok": True})
        if path == "/api/admin/deploy/status":
            if not require_admin(self):
                return
            return send_json(
                self,
                {
                    "last": deploy.get_last_result(),
                    "git": deploy.is_git_repo(),
                    "busy": deploy.is_busy(),
                },
            )
        if path == "/api/family/state":
            return send_json(self, db.public_state())
        if path == "/api/family/revision":
            return send_json(self, {"revision": db.get_revision()})
        if path == "/api/family/kids":
            return send_json(self, {"items": db.load_db().get("kids", [])})
        if path == "/api/family/chores":
            return send_json(self, {"items": db.load_db().get("chores", [])})
        if path == "/api/family/rewards":
            return send_json(self, {"items": db.load_db().get("rewards", [])})
        if path.startswith("/api/family/lists/"):
            name = path.split("/")[-1]
            lists = db.load_db().get("lists", {})
            return send_json(self, {"name": name, "items": lists.get(name, [])})
        if path == "/api/family/whiteboard":
            state = db.load_db()
            return send_json(self, state.get("whiteboard") or {"version": 1, "strokes": [], "updatedAt": 0})
        if path == "/api/screensaver/manifest":
            return self.screensaver_manifest()
        if path == "/api/screensaver/photo":
            return self.screensaver_photo(parsed.query)

        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = (parsed.path.rstrip("/") or "/").lower()

        if path == "/api/webhooks/github":
            return self.github_webhook()
        if path == "/api/webhooks/deploy":
            return self.deploy_webhook()

        payload = read_json(self)

        if path == "/api/auth/login":
            return self.auth_login(payload)
        if path == "/api/auth/logout":
            return self.auth_logout()

        # Kiosk actions (no admin auth — device is trusted on LAN for now)
        if path == "/api/family/chores/toggle":
            return self.chore_toggle(payload)
        if path == "/api/family/lists/add":
            return self.list_add(payload)
        if path == "/api/family/lists/toggle":
            return self.list_toggle(payload)
        if path == "/api/family/lists/restore":
            return self.list_restore(payload)
        if path == "/api/family/rewards/redeem":
            return self.reward_redeem(payload)
        if path == "/api/family/whiteboard":
            return self.whiteboard_save(payload)

        # Admin mutations
        if path == "/api/family/kids":
            if not require_admin(self):
                return
            return self.kids_upsert(payload)
        if path == "/api/family/chores":
            if not require_admin(self):
                return
            return self.chores_upsert(payload)
        if path == "/api/family/rewards":
            if not require_admin(self):
                return
            return self.rewards_upsert(payload)
        if path == "/api/family/stars":
            if not require_admin(self):
                return
            return self.stars_adjust(payload)
        if path == "/api/family/lists/replace":
            if not require_admin(self):
                return
            return self.list_replace(payload)
        if path == "/api/family/settings":
            if not require_admin(self):
                return
            return self.settings_update(payload)

        if path == "/api/screensaver/upload":
            if not require_admin(self):
                return
            return self.screensaver_upload(payload)

        if path == "/api/admin/restart":
            if not require_admin(self):
                return
            return self.admin_restart()

        if path == "/api/admin/deploy":
            if not require_admin(self):
                return
            return self.admin_deploy()

        send_json(self, {"error": "Not found", "path": path, "hint": "Restart server: npm start"}, 404)

    def do_PUT(self):
        self.do_POST()

    def do_PATCH(self):
        self.do_POST()

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/")
        if not require_admin(self):
            return

        state = db.load_db()
        if path.startswith("/api/family/kids/"):
            kid_id = path.split("/")[-1]
            state["kids"] = [k for k in state.get("kids", []) if k.get("id") != kid_id]
            state.get("balances", {}).pop(kid_id, None)
            for chore in state.get("chores", []):
                kid_ids = chore.get("kidIds") or []
                if kid_id in kid_ids:
                    chore["kidIds"] = [x for x in kid_ids if x != kid_id]
            for day_bucket in state.get("completions", {}).values():
                if isinstance(day_bucket, dict):
                    for key in list(day_bucket.keys()):
                        if key.endswith(f":{kid_id}"):
                            del day_bucket[key]
            db.save_db(state)
            return send_json(self, {"ok": True})
        if path.startswith("/api/family/chores/"):
            chore_id = path.split("/")[-1]
            state["chores"] = [c for c in state.get("chores", []) if c.get("id") != chore_id]
            prefix = f"{chore_id}:"
            for day_bucket in state.get("completions", {}).values():
                if isinstance(day_bucket, dict):
                    for key in list(day_bucket.keys()):
                        if key.startswith(prefix):
                            del day_bucket[key]
            db.save_db(state)
            return send_json(self, {"ok": True})
        if path.startswith("/api/family/rewards/"):
            reward_id = path.split("/")[-1]
            state["rewards"] = [r for r in state.get("rewards", []) if r.get("id") != reward_id]
            db.save_db(state)
            return send_json(self, {"ok": True})
        if path.startswith("/api/screensaver/photos/"):
            photo_id = path.split("/")[-1]
            photos = state.get("screensaverPhotos") or []
            item = next((p for p in photos if p.get("id") == photo_id), None)
            if item:
                file_path = PHOTOS_DIR / item.get("filename", "")
                if file_path.exists():
                    file_path.unlink()
            state["screensaverPhotos"] = [p for p in photos if p.get("id") != photo_id]
            db.save_db(state)
            return send_json(self, {"ok": True})
        if path.startswith("/api/family/lists/") and path.count("/") >= 5:
            # /api/family/lists/{name}/{itemId}
            parts = path.split("/")
            name, item_id = parts[-2], parts[-1]
            items = state.setdefault("lists", {}).setdefault(name, [])
            state["lists"][name] = [i for i in items if i.get("id") != item_id]
            db.save_db(state)
            return send_json(self, {"ok": True})

        send_json(self, {"error": "Not found"}, 404)

    # ---- auth ----
    def auth_login(self, payload: dict):
        # Password optional — always issue a session token for this home install
        token = secrets.token_urlsafe(24)
        SESSIONS[token] = time.time() + SESSION_HOURS * 3600
        return send_json(self, {"token": token, "expiresInHours": SESSION_HOURS, "openAccess": True})

    def auth_logout(self):
        auth = self.headers.get("Authorization") or ""
        token = auth.replace("Bearer", "").strip()
        SESSIONS.pop(token, None)
        return send_json(self, {"ok": True})

    # ---- calendar ----
    def proxy_calendar(self):
        ics_url = load_secrets().get("icsUrl")
        if not ics_url:
            return send_json(
                self,
                {
                    "error": "Missing icsUrl in shared/secrets.local.js (gitignored — copy it onto the Pi)",
                },
                500,
            )
        try:
            req = urllib.request.Request(
                ics_url,
                headers={
                    "User-Agent": "Mozilla/5.0 (compatible; FamilyBoard/1.0)",
                    "Accept": "text/calendar, text/plain, */*",
                },
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
            if not data or b"BEGIN:VCALENDAR" not in data[:200]:
                return send_json(
                    self,
                    {"error": "icsUrl did not return a Google iCal feed — reset the secret address in Google Calendar settings"},
                    502,
                )
            self.send_response(200)
            self.send_header("Content-Type", "text/calendar; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as exc:  # noqa: BLE001
            send_json(self, {"error": f"Calendar fetch failed: {exc}"}, 502)

    # ---- family mutations ----
    def kids_upsert(self, payload: dict):
        state = db.load_db()
        kid = {
            "id": payload.get("id") or new_id("kid"),
            "name": (payload.get("name") or "Kid").strip(),
            "emoji": payload.get("emoji") or "⭐",
            "color": payload.get("color") or "#5aa7ff",
            "active": payload.get("active", True),
        }
        kids = state.setdefault("kids", [])
        for i, existing in enumerate(kids):
            if existing.get("id") == kid["id"]:
                kids[i] = {**existing, **kid}
                break
        else:
            kids.append(kid)
            state.setdefault("balances", {})[kid["id"]] = 0
        db.save_db(state)
        send_json(self, {"item": kid, "state": db.public_state(state)})

    def chores_upsert(self, payload: dict):
        state = db.load_db()
        chores = state.setdefault("chores", [])
        existing = next((c for c in chores if c.get("id") == payload.get("id")), {})
        chore = {
            "id": payload.get("id") or new_id("chore"),
            "title": (payload.get("title") or existing.get("title") or "Chore").strip(),
            "icon": payload.get("icon") or existing.get("icon") or "✅",
            "stars": max(1, min(99, int(payload.get("stars") or existing.get("stars") or 1))),
            "kidIds": payload.get("kidIds")
            if payload.get("kidIds") is not None
            else (existing.get("kidIds") or []),
            "period": payload.get("period") or existing.get("period") or "chore",
            "repeat": payload.get("repeat") or existing.get("repeat") or "daily",
            "hint": (
                payload.get("hint")
                if payload.get("hint") is not None
                else (existing.get("hint") or "")
            ).strip(),
            "checkStyle": self._normalize_check_style(
                payload.get("checkStyle"), existing.get("checkStyle", "circle")
            ),
            "active": payload.get("active", existing.get("active", True)),
        }
        for i, row in enumerate(chores):
            if row.get("id") == chore["id"]:
                chores[i] = {**row, **chore}
                break
        else:
            chores.append(chore)
        db.save_db(state)
        send_json(self, {"item": chore, "state": db.public_state(state)})

    def rewards_upsert(self, payload: dict):
        state = db.load_db()
        reward = {
            "id": payload.get("id") or new_id("reward"),
            "title": (payload.get("title") or "Reward").strip(),
            "icon": payload.get("icon") or "🎁",
            "cost": int(payload.get("cost") or 10),
            "active": payload.get("active", True),
        }
        rewards = state.setdefault("rewards", [])
        for i, existing in enumerate(rewards):
            if existing.get("id") == reward["id"]:
                rewards[i] = {**existing, **reward}
                break
        else:
            rewards.append(reward)
        db.save_db(state)
        send_json(self, {"item": reward, "state": db.public_state(state)})

    def stars_adjust(self, payload: dict):
        state = db.load_db()
        kid_id = payload.get("kidId")
        delta = int(payload.get("delta") or 0)
        if not kid_id:
            return send_json(self, {"error": "kidId required"}, 400)
        bal = state.setdefault("balances", {})
        bal[kid_id] = max(0, int(bal.get(kid_id) or 0) + delta)
        db.save_db(state)
        send_json(self, {"balance": bal[kid_id], "state": db.public_state(state)})

    def list_replace(self, payload: dict):
        state = db.load_db()
        name = payload.get("name")
        items = payload.get("items")
        if name not in ("grocery", "reminders") or not isinstance(items, list):
            return send_json(self, {"error": "Invalid list"}, 400)
        state.setdefault("lists", {})[name] = items
        db.save_db(state)
        send_json(self, {"state": db.public_state(state)})

    def list_add(self, payload: dict):
        state = db.load_db()
        name = payload.get("name")
        text = (payload.get("text") or "").strip()
        if name not in ("grocery", "reminders") or not text:
            return send_json(self, {"error": "name and text required"}, 400)
        item = {"id": new_id("item"), "text": text, "done": False}
        state.setdefault("lists", {}).setdefault(name, []).insert(0, item)
        db.save_db(state)
        send_json(self, {"item": item, "state": db.public_state(state)})

    def list_toggle(self, payload: dict):
        state = db.load_db()
        name = payload.get("name")
        item_id = payload.get("itemId")
        if name not in ("grocery", "reminders"):
            return send_json(self, {"error": "Invalid list"}, 400)
        items = state.setdefault("lists", {}).setdefault(name, [])
        for i, item in enumerate(items):
            if item.get("id") == item_id:
                # Checking off clears the item (grocery/reminder complete)
                removed = items.pop(i)
                db.save_db(state)
                return send_json(
                    self,
                    {
                        "removed": True,
                        "itemId": item_id,
                        "item": removed,
                        "index": i,
                        "state": db.public_state(state),
                    },
                )
        send_json(self, {"error": "Item not found"}, 404)

    def list_restore(self, payload: dict):
        state = db.load_db()
        name = payload.get("name")
        item = payload.get("item")
        if name not in ("grocery", "reminders") or not isinstance(item, dict):
            return send_json(self, {"error": "Invalid list"}, 400)
        if not item.get("id"):
            return send_json(self, {"error": "item required"}, 400)
        items = state.setdefault("lists", {}).setdefault(name, [])
        if any(existing.get("id") == item.get("id") for existing in items):
            return send_json(self, {"ok": True, "state": db.public_state(state)})
        index = payload.get("index")
        if isinstance(index, int) and 0 <= index <= len(items):
            items.insert(index, item)
        else:
            items.insert(0, item)
        db.save_db(state)
        send_json(self, {"ok": True, "state": db.public_state(state)})

    def whiteboard_save(self, payload: dict):
        strokes = payload.get("strokes")
        if not isinstance(strokes, list):
            return send_json(self, {"error": "strokes array required"}, 400)
        state = db.load_db()
        state["whiteboard"] = {
            "version": 1,
            "strokes": strokes[:2000],
            "updatedAt": int(time.time() * 1000),
        }
        db.save_db(state)
        send_json(self, {"ok": True, "whiteboard": state["whiteboard"]})

    def settings_update(self, payload: dict):
        state = db.load_db()
        settings = state.setdefault("settings", {})
        night = payload.get("nightMode")
        if isinstance(night, dict):
            current = settings.get("nightMode") or {}
            settings["nightMode"] = {
                "enabled": bool(night.get("enabled", current.get("enabled", False))),
                "dimTime": self._normalize_time(night.get("dimTime"), current.get("dimTime", "22:00")),
                "brightTime": self._normalize_time(
                    night.get("brightTime"), current.get("brightTime", "06:00")
                ),
                "brightness": self._normalize_brightness(
                    night.get("brightness"), current.get("brightness", 15)
                ),
            }
        ss = payload.get("screensaver")
        if isinstance(ss, dict):
            current = settings.get("screensaver") or {}
            sources = ss.get("sources")
            normalized_sources = current.get("sources", [])
            if sources is not None:
                normalized_sources = []
                for src in sources:
                    if not isinstance(src, dict):
                        continue
                    normalized_sources.append(
                        {
                            "id": src.get("id") or new_id("album"),
                            "type": str(src.get("type") or "urls"),
                            "label": (src.get("label") or "Album").strip(),
                            "url": (src.get("url") or "").strip(),
                            "enabled": src.get("enabled", True),
                        }
                    )
            settings["screensaver"] = {
                "enabled": bool(ss.get("enabled", current.get("enabled", False))),
                "idleMinutes": max(0, min(180, int(ss.get("idleMinutes", current.get("idleMinutes", 5))))),
                "slideSeconds": max(
                    4, min(120, int(ss.get("slideSeconds", current.get("slideSeconds", 12))))
                ),
                "scheduleEnabled": bool(
                    ss.get("scheduleEnabled", current.get("scheduleEnabled", False))
                ),
                "startTime": self._normalize_time(
                    ss.get("startTime"), current.get("startTime", "22:00")
                ),
                "endTime": self._normalize_time(ss.get("endTime"), current.get("endTime", "06:00")),
                "sources": normalized_sources,
            }
            active_ids = ss.get("activeAlbumIds")
            if active_ids is not None:
                settings["screensaver"]["activeAlbumIds"] = [
                    str(aid) for aid in active_ids if aid
                ]
            elif "activeAlbumIds" in current:
                settings["screensaver"]["activeAlbumIds"] = list(current.get("activeAlbumIds") or [])
            ss_out = settings["screensaver"]
            if ss_out["enabled"] and ss_out["idleMinutes"] == 0 and not ss_out["scheduleEnabled"]:
                ss_out["idleMinutes"] = 5
        rot = payload.get("rotation")
        if isinstance(rot, dict):
            current = settings.get("rotation") or {}
            current_screens = (current.get("screens") or {}) if isinstance(current, dict) else {}
            new_screens = rot.get("screens")
            merged_screens = db.default_rotation_screens()
            if isinstance(new_screens, dict):
                for sid in db.KIOSK_SCREEN_IDS:
                    src = new_screens.get(sid) or current_screens.get(sid) or {}
                    merged_screens[sid] = {
                        "enabled": bool(src.get("enabled", merged_screens[sid]["enabled"])),
                        "seconds": max(
                            5,
                            min(
                                600,
                                int(src.get("seconds", merged_screens[sid]["seconds"])),
                            ),
                        ),
                    }
            settings["rotation"] = {
                "pauseOnTouchSeconds": max(
                    0,
                    min(
                        600,
                        int(
                            rot.get(
                                "pauseOnTouchSeconds",
                                current.get("pauseOnTouchSeconds", 120),
                            )
                        ),
                    ),
                ),
                "screens": merged_screens,
            }
        db.save_db(state)
        send_json(self, {"ok": True, "settings": db.public_state(state)["settings"]})

    def screensaver_manifest(self):
        state = db.load_db()
        photos = screensaver_albums.build_photo_manifest(state)
        ss = db.merged_settings(state).get("screensaver") or {}
        return send_json(
            self,
            {
                "photos": photos,
                "count": len(photos),
                "slideSeconds": ss.get("slideSeconds", 12),
                "activeAlbumIds": (state.get("settings") or {}).get("screensaver", {}).get(
                    "activeAlbumIds"
                ),
            },
        )

    def screensaver_photo(self, query: str):
        params = urllib.parse.parse_qs(query or "")
        photo_id = (params.get("id") or [None])[0]
        local_id = (params.get("local") or [None])[0]
        remote = (params.get("remote") or [None])[0]

        if photo_id:
            remote = screensaver_albums.lookup_photo(photo_id)
            if not remote:
                return send_json(self, {"error": "Not found — refresh manifest"}, 404)

        if local_id:
            state = db.load_db()
            item = next(
                (p for p in state.get("screensaverPhotos") or [] if p.get("id") == local_id),
                None,
            )
            if not item:
                return send_json(self, {"error": "Not found"}, 404)
            file_path = PHOTOS_DIR / str(item.get("filename") or "")
            if not file_path.is_file():
                return send_json(self, {"error": "Not found"}, 404)
            data = file_path.read_bytes()
            ctype = mimetypes.guess_type(str(file_path))[0] or "image/jpeg"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "public, max-age=86400")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        if remote:
            if not self._remote_photo_allowed(remote):
                return send_json(self, {"error": "Forbidden"}, 403)
            try:
                req = urllib.request.Request(
                    remote,
                    headers={"User-Agent": screensaver_albums.USER_AGENT},
                )
                with urllib.request.urlopen(req, timeout=45) as resp:
                    data = resp.read()
                    ctype = resp.headers.get("Content-Type") or "image/jpeg"
            except Exception as exc:  # noqa: BLE001
                return send_json(self, {"error": str(exc)}, 502)
            self.send_response(200)
            self.send_header("Content-Type", ctype.split(";")[0])
            self.send_header("Cache-Control", "public, max-age=3600")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        send_json(self, {"error": "Missing local or remote parameter"}, 400)

    @staticmethod
    def _remote_photo_allowed(url: str) -> bool:
        host = urllib.parse.urlparse(url).hostname or ""
        safe_hosts = (
            "googleusercontent.com",
            "icloud.com",
            "icloud-content.com",
            "apple-cloudkit.com",
            "blob.core.windows.net",
            "images.unsplash.com",
        )
        return any(host == h or host.endswith(f".{h}") for h in safe_hosts)

    def screensaver_upload(self, payload: dict):
        raw = payload.get("data") or ""
        if not raw:
            return send_json(self, {"error": "Missing image data"}, 400)
        if "," in raw:
            raw = raw.split(",", 1)[1]
        try:
            data = base64.b64decode(raw)
        except Exception:  # noqa: BLE001
            return send_json(self, {"error": "Invalid image data"}, 400)
        if len(data) > 12 * 1024 * 1024:
            return send_json(self, {"error": "Image too large (max 12MB)"}, 400)

        name = str(payload.get("filename") or "photo.jpg")
        ext = Path(name).suffix.lower()
        if ext not in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
            ext = ".jpg"

        PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
        photo_id = new_id("photo")
        filename = f"{photo_id}{ext}"
        (PHOTOS_DIR / filename).write_bytes(data)

        state = db.load_db()
        item = {
            "id": photo_id,
            "filename": filename,
            "label": (payload.get("label") or name).strip(),
            "addedAt": int(time.time() * 1000),
        }
        state.setdefault("screensaverPhotos", []).append(item)
        db.save_db(state)
        send_json(self, {"ok": True, "photo": item})

    @staticmethod
    def _normalize_time(value: Any, fallback: str) -> str:
        text = str(value or fallback).strip()
        match = re.match(r"^(\d{1,2}):(\d{2})(?::\d{2})?$", text)
        if not match:
            return fallback
        hour = max(0, min(23, int(match.group(1))))
        minute = max(0, min(59, int(match.group(2))))
        return f"{hour:02d}:{minute:02d}"

    @staticmethod
    def _normalize_brightness(value: Any, fallback: int) -> int:
        try:
            level = int(value)
        except (TypeError, ValueError):
            level = int(fallback)
        return max(1, min(100, level))

    @staticmethod
    def _normalize_check_style(value: Any, fallback: str = "circle") -> str:
        style = str(value or fallback or "circle").lower()
        return style if style in CHECK_STYLES else "circle"

    def chore_toggle(self, payload: dict):
        state = db.load_db()
        chore_id = payload.get("choreId")
        kid_id = payload.get("kidId")
        if not chore_id or not kid_id:
            return send_json(self, {"error": "choreId and kidId required"}, 400)

        chore = next((c for c in state.get("chores", []) if c.get("id") == chore_id), None)
        if not chore:
            return send_json(self, {"error": "Chore not found"}, 404)

        day = db.today_key()
        bucket = state.setdefault("completions", {}).setdefault(day, {})
        key = f"{chore_id}:{kid_id}"
        bal = state.setdefault("balances", {})
        bal[kid_id] = int(bal.get(kid_id) or 0)

        if bucket.get(key):
            refund = db.completion_stars(bucket.get(key), chore)
            del bucket[key]
            bal[kid_id] = max(0, bal[kid_id] - refund)
            done = False
            stars_earned = 0
            late = False
        else:
            stars_earned, late = db.chore_stars_for_now(chore)
            bucket[key] = {"stars": stars_earned, "late": late}
            bal[kid_id] += stars_earned
            done = True

        db.save_db(state)
        send_json(
            self,
            {
                "done": done,
                "balance": bal[kid_id],
                "starsEarned": stars_earned,
                "late": late,
                "state": db.public_state(state),
            },
        )

    def reward_redeem(self, payload: dict):
        state = db.load_db()
        reward_id = payload.get("rewardId")
        kid_id = payload.get("kidId")
        reward = next((r for r in state.get("rewards", []) if r.get("id") == reward_id), None)
        if not reward or not kid_id:
            return send_json(self, {"error": "Invalid reward"}, 400)
        cost = int(reward.get("cost") or 0)
        bal = state.setdefault("balances", {})
        current = int(bal.get(kid_id) or 0)
        if current < cost:
            return send_json(self, {"error": "Not enough stars", "balance": current}, 400)
        bal[kid_id] = current - cost
        kid = next((k for k in state.get("kids", []) if k.get("id") == kid_id), {})
        state.setdefault("redemptions", []).insert(
            0,
            {
                "id": new_id("redeem"),
                "kidId": kid_id,
                "kidName": kid.get("name") or kid_id,
                "rewardId": reward_id,
                "title": reward.get("title"),
                "icon": reward.get("icon"),
                "cost": cost,
                "at": int(time.time() * 1000),
            },
        )
        db.save_db(state)
        send_json(self, {"ok": True, "balance": bal[kid_id], "state": db.public_state(state)})

    def admin_restart(self):
        schedule_server_restart()
        send_json(self, {"ok": True, "restarting": True})

    def admin_deploy(self):
        result = deploy.deploy_async(schedule_server_restart, restart=True)
        status = 200 if result.get("ok") else 409
        send_json(self, result, status)

    def deploy_webhook(self):
        secret = load_secrets().get("deployWebhookSecret") or ""
        if not secret:
            return send_json(self, {"error": "deployWebhookSecret not configured"}, 503)

        token = (self.headers.get("X-Deploy-Token") or "").strip()
        if not hmac.compare_digest(token, secret):
            return send_json(self, {"error": "Unauthorized"}, 401)

        result = deploy.deploy_async(schedule_server_restart, restart=True)
        send_json(self, result, 202 if result.get("ok") else 409)

    def github_webhook(self):
        secret = load_secrets().get("deployWebhookSecret") or ""
        if not secret:
            return send_json(self, {"error": "deployWebhookSecret not configured"}, 503)

        body = read_raw_body(self)
        signature = self.headers.get("X-Hub-Signature-256") or ""
        if signature:
            expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(signature, expected):
                return send_json(self, {"error": "Invalid signature"}, 401)
        else:
            token = (self.headers.get("X-Deploy-Token") or "").strip()
            if not hmac.compare_digest(token, secret):
                return send_json(self, {"error": "Unauthorized"}, 401)

        try:
            payload = json.loads(body.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            return send_json(self, {"error": "Invalid JSON"}, 400)

        event = (self.headers.get("X-GitHub-Event") or "").lower()
        if event == "ping":
            return send_json(self, {"ok": True, "pong": True})

        if event != "push":
            return send_json(self, {"ok": True, "ignored": True, "event": event})

        branch = (load_secrets().get("deployBranch") or "main").strip()
        allowed = {branch, "main", "master"}
        ref = payload.get("ref") or ""
        pushed = ref.replace("refs/heads/", "")
        if pushed not in allowed:
            return send_json(self, {"ok": True, "ignored": True, "branch": pushed})

        result = deploy.deploy_async(schedule_server_restart, restart=True)
        send_json(self, {**result, "branch": pushed}, 202 if result.get("ok") else 409)

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))


if __name__ == "__main__":
    import errno
    import os

    # Always run from the repo root so relative static paths work on Pi/systemd
    os.chdir(ROOT)
    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
    (ROOT / "data").mkdir(parents=True, exist_ok=True)

    if sys.version_info < (3, 9):
        print(
            f"ERROR: Python 3.9+ required (found {sys.version.split()[0]}). "
            "On Raspberry Pi OS: sudo apt install python3",
            flush=True,
        )
        raise SystemExit(1)

    try:
        db.load_db()
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: could not initialize data/family.json: {exc}", flush=True)
        raise SystemExit(1) from exc

    try:
        server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    except OSError as exc:
        if getattr(exc, "errno", None) in (errno.EADDRINUSE, 98, 10048):
            print(
                f"\nERROR: port {PORT} is already in use.\n"
                "Free it, then try again:\n"
                f"  sudo fuser -k {PORT}/tcp\n"
                "  # or: sudo systemctl stop family-board-api\n"
                "  python3 server.py\n",
                flush=True,
            )
            raise SystemExit(1) from exc
        print(f"ERROR: could not bind to 0.0.0.0:{PORT}: {exc}", flush=True)
        raise SystemExit(1) from exc

    print(f"Family Board API v{API_VERSION} on port {PORT}", flush=True)
    print(f"Family Board  -> http://127.0.0.1:{PORT}/", flush=True)
    print(f"Admin PWA     -> http://127.0.0.1:{PORT}/admin/  (tunnel: /phone/)", flush=True)
    print(f"Health check  -> http://127.0.0.1:{PORT}/api/health", flush=True)
    print(f"Family API    -> http://127.0.0.1:{PORT}/api/family/state", flush=True)
    print(f"Calendar ICS  -> http://127.0.0.1:{PORT}/api/calendar", flush=True)
    print(f"Root          -> {ROOT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.", flush=True)
        server.server_close()
