"""
Family Board local server
- Static site + admin PWA
- /api/calendar → Google Calendar API (OAuth colors) or private iCal fallback
- /api/family/* → chores, lists, rewards, kids (admin + kiosk)
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import mimetypes
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import date, datetime, timedelta, timezone
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
API_VERSION = 3
BOOT_ID = uuid.uuid4().hex
STARTED_AT = int(time.time() * 1000)
PHOTOS_DIR = ROOT / "data" / "photos"
CAL_CACHE = ROOT / "data" / "calendar-cache.ics"
CAL_JSON_CACHE = ROOT / "data" / "calendar-cache.json"
CONFIG_JS = ROOT / "shared" / "config.js"
SECRETS = ROOT / "shared" / "secrets.local.js"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_COLORS_URL = "https://www.googleapis.com/calendar/v3/colors"
GOOGLE_CAL_API = "https://www.googleapis.com/calendar/v3"
_oauth_lock = threading.Lock()
_oauth_access = {"token": "", "expires_at": 0.0}
_oauth_colors = {"event": {}, "fetched_at": 0.0}
SESSIONS: dict[str, float] = {}  # token -> expires_at
FILE_SESSIONS: dict[str, float] = {}  # files token -> expires_at
SESSION_HOURS = 30 * 24
FILE_SESSION_HOURS = 8
FILES_PASSWORD_DEFAULT = "fifimister3"
ADMIN_FILE_MAX_BYTES = 512_000
BROWSE_SKIP_NAMES = frozenset({".git", "node_modules", "__pycache__", ".cursor", ".venv", "venv"})
BROWSE_TEXT_SUFFIXES = frozenset({
    ".js", ".css", ".html", ".md", ".json", ".py", ".txt", ".env", ".example",
    ".yml", ".yaml", ".toml", ".sh", ".svg", ".csv", ".gitignore", ".webmanifest",
})
ADMIN_FILES: dict[str, dict[str, Any]] = {
    "secrets": {
        "rel": "shared/secrets.local.js",
        "label": "Secrets",
        "hint": "Paste the Google Calendar secret iCal URL, admin password, and deploy webhook here. This file is gitignored.",
        "writable": True,
        "fallback": "shared/secrets.example.js",
    },
    "secrets-example": {
        "rel": "shared/secrets.example.js",
        "label": "Secrets example",
        "hint": "Template only. Copy values into Secrets — this file is not saved.",
        "writable": False,
    },
    "config": {
        "rel": "shared/config.js",
        "label": "App config",
        "hint": "Weather location, calendar IDs, and display size. A git pull may overwrite this file.",
        "writable": True,
    },
    "kiosk-env": {
        "rel": "scripts/pi/kiosk.env",
        "label": "Pi kiosk env",
        "hint": "Display rotation and start URL used when the kiosk launches on the Pi.",
        "writable": True,
    },
}


def admin_file_meta(file_id: str) -> dict[str, Any] | None:
    meta = ADMIN_FILES.get(file_id)
    if not meta:
        return None
    path = (ROOT / str(meta["rel"])).resolve()
    root = ROOT.resolve()
    if path != root and root not in path.parents:
        return None
    return {**meta, "id": file_id, "path": path}


def read_admin_file(file_id: str) -> dict[str, Any]:
    meta = admin_file_meta(file_id)
    if not meta:
        raise FileNotFoundError("Unknown file")
    path: Path = meta["path"]
    exists = path.is_file()
    text = ""
    if exists:
        text = path.read_text(encoding="utf-8")
    elif meta.get("fallback"):
        fallback = (ROOT / str(meta["fallback"])).resolve()
        if fallback.is_file() and (fallback == ROOT.resolve() or ROOT.resolve() in fallback.parents):
            text = fallback.read_text(encoding="utf-8")
    return {
        "id": meta["id"],
        "label": meta["label"],
        "hint": meta["hint"],
        "rel": meta["rel"],
        "writable": bool(meta["writable"]),
        "exists": exists,
        "content": text,
    }


def write_admin_file(file_id: str, content: str) -> dict[str, Any]:
    meta = admin_file_meta(file_id)
    if not meta:
        raise FileNotFoundError("Unknown file")
    if not meta["writable"]:
        raise PermissionError("This file is read-only")
    if len(content.encode("utf-8")) > ADMIN_FILE_MAX_BYTES:
        raise ValueError("File is too large")
    path: Path = meta["path"]
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(content.replace("\r\n", "\n"), encoding="utf-8")
    tmp.replace(path)
    return read_admin_file(file_id)


def resolve_browse_path(rel: str) -> Path:
    raw = (rel or "").replace("\\", "/").strip().lstrip("/")
    if any(part == ".." for part in raw.split("/")):
        raise ValueError("Invalid path")
    root = ROOT.resolve()
    path = (root / raw).resolve() if raw else root
    if path != root and root not in path.parents:
        raise ValueError("Invalid path")
    parts = path.relative_to(root).parts if path != root else ()
    if any(part in BROWSE_SKIP_NAMES for part in parts):
        raise ValueError("That folder is hidden")
    return path


def browse_rel(path: Path) -> str:
    root = ROOT.resolve()
    if path == root:
        return ""
    return path.relative_to(root).as_posix()


def is_text_file(path: Path) -> bool:
    suffix = path.suffix.lower()
    if suffix in BROWSE_TEXT_SUFFIXES:
        return True
    if suffix:
        return False
    try:
        chunk = path.read_bytes()[:2048]
    except OSError:
        return False
    if b"\x00" in chunk:
        return False
    try:
        chunk.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def list_browse_dir(rel: str) -> dict[str, Any]:
    path = resolve_browse_path(rel)
    if not path.is_dir():
        raise FileNotFoundError("Not a folder")
    entries: list[dict[str, Any]] = []
    for child in sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        if child.name in BROWSE_SKIP_NAMES:
            continue
        if child.name.startswith(".") and child.name not in {".gitignore", ".env"}:
            continue
        item: dict[str, Any] = {
            "name": child.name,
            "path": browse_rel(child),
            "type": "dir" if child.is_dir() else "file",
        }
        if child.is_file():
            try:
                item["size"] = child.stat().st_size
            except OSError:
                item["size"] = 0
            item["text"] = is_text_file(child)
        entries.append(item)
    parent = browse_rel(path.parent) if path != ROOT.resolve() else None
    return {
        "root": "family-board-src",
        "path": browse_rel(path),
        "parent": parent,
        "entries": entries,
    }


def read_browse_file(rel: str) -> dict[str, Any]:
    path = resolve_browse_path(rel)
    if not path.is_file():
        raise FileNotFoundError("File not found")
    rel_path = browse_rel(path)
    if not is_text_file(path):
        return {
            "path": rel_path,
            "label": path.name,
            "writable": False,
            "binary": True,
            "content": "",
            "hint": "This file is not text, so it cannot be edited here.",
        }
    text = path.read_text(encoding="utf-8")
    return {
        "path": rel_path,
        "label": path.name,
        "writable": True,
        "binary": False,
        "content": text,
        "hint": f"family-board-src/{rel_path}" if rel_path else path.name,
    }


def write_browse_file(rel: str, content: str) -> dict[str, Any]:
    path = resolve_browse_path(rel)
    if path.exists() and path.is_dir():
        raise ValueError("That path is a folder")
    if path.exists() and not is_text_file(path):
        raise PermissionError("This file is not text")
    if len(content.encode("utf-8")) > ADMIN_FILE_MAX_BYTES:
        raise ValueError("File is too large")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(content.replace("\r\n", "\n"), encoding="utf-8")
    tmp.replace(path)
    return read_browse_file(rel)


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
        "filesPassword",
        "deployWebhookSecret",
        "deployBranch",
    ):
        match = re.search(rf'{key}:\s*"([^"]*)"', text)
        if match:
            out[key] = match.group(1).strip()
    return out


def oauth_calendar_configured() -> bool:
    secrets_map = load_secrets()
    return bool(
        secrets_map.get("googleClientId")
        and secrets_map.get("googleClientSecret")
        and secrets_map.get("googleRefreshToken")
    )


def load_config_calendar() -> dict[str, Any]:
    text = CONFIG_JS.read_text(encoding="utf-8") if CONFIG_JS.exists() else ""
    cal_id = ""
    days = 21
    match = re.search(r'calendarId:\s*"([^"]+)"', text)
    if match:
        cal_id = match.group(1).strip()
    days_match = re.search(r"daysAhead:\s*(\d+)", text)
    if days_match:
        days = max(1, int(days_match.group(1)))
    return {"calendarId": cal_id, "daysAhead": days}


ROCHELLE_WEATHER = {
    "latitude": 41.9239,
    "longitude": -89.0687,
    "zip": "61068",
    "station": "KRPJ",
    "place": "Rochelle, IL",
    "timezone": "America/Chicago",
}
_weather_cache: dict[str, Any] = {"at": 0.0, "data": None}
WEATHER_CACHE_SEC = 45
NWS_UA = "FamilyBoard/1.0 (Rochelle IL 61068 kiosk)"


def load_config_weather() -> dict[str, Any]:
    cfg = dict(ROCHELLE_WEATHER)
    text = CONFIG_JS.read_text(encoding="utf-8") if CONFIG_JS.exists() else ""
    lat = re.search(r"latitude:\s*(-?\d+(?:\.\d+)?)", text)
    lon = re.search(r"longitude:\s*(-?\d+(?:\.\d+)?)", text)
    station = re.search(r'station:\s*"([^"]+)"', text)
    place = re.search(r'placeLabel:\s*"([^"]+)"', text)
    zip_code = re.search(r'zip:\s*"([^"]+)"', text)
    tz = re.search(r'timezone:\s*"([^"]+)"', text)
    if lat:
        cfg["latitude"] = float(lat.group(1))
    if lon:
        cfg["longitude"] = float(lon.group(1))
    if station:
        cfg["station"] = station.group(1).strip() or cfg["station"]
    if place:
        cfg["place"] = place.group(1).strip() or cfg["place"]
    if zip_code:
        cfg["zip"] = zip_code.group(1).strip() or cfg["zip"]
    if tz:
        cfg["timezone"] = tz.group(1).strip() or cfg["timezone"]
    return cfg


def _weather_http_json(url: str, timeout: int = 12) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/geo+json, application/json",
            "User-Agent": NWS_UA,
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _nws_code_from_text(text: str, icon: str) -> tuple[int, bool]:
    blob = f"{icon} {text}".lower()
    is_day = "/night/" not in icon.lower()
    pairs = (
        ("tsra", 95),
        ("thunder", 95),
        ("blizzard", 75),
        ("heavy snow", 75),
        ("snow", 71),
        ("sleet", 66),
        ("freezing", 66),
        ("rain_showers", 80),
        ("shra", 80),
        ("shower", 80),
        ("heavy rain", 65),
        ("rain", 61),
        ("drizzle", 51),
        ("fog", 45),
        ("haze", 45),
        ("ovc", 3),
        ("overcast", 3),
        ("cloudy", 3),
        ("bkn", 3),
        ("sct", 2),
        ("partly", 2),
        ("few", 1),
        ("mostly clear", 1),
        ("mostly sunny", 1),
        ("skc", 0),
        ("clear", 0),
        ("sunny", 0),
        ("fair", 0),
    )
    for needle, code in pairs:
        if needle in blob:
            return code, is_day
    return 2, is_day


def _c_to_f(value: float) -> float:
    return value * 9.0 / 5.0 + 32.0


def _nws_current(cfg: dict[str, Any]) -> dict[str, Any] | None:
    station = cfg.get("station") or "KRPJ"
    data = _weather_http_json(f"https://api.weather.gov/stations/{station}/observations/latest")
    props = data.get("properties") or {}
    temp = (props.get("temperature") or {}).get("value")
    if temp is None:
        return None
    stamp = str(props.get("timestamp") or "")
    if stamp:
        try:
            observed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
            age = datetime.now(timezone.utc) - observed.astimezone(timezone.utc)
            if age.total_seconds() > 3 * 60 * 60:
                return None
        except Exception:  # noqa: BLE001
            pass
    icon = str(props.get("icon") or "")
    text = str(props.get("textDescription") or "")
    code, is_day = _nws_code_from_text(text, icon)
    wind = (props.get("windSpeed") or {}).get("value")
    wind_unit = str((props.get("windSpeed") or {}).get("unitCode") or "")
    if wind is None:
        wind_mph = None
    elif "m_s" in wind_unit:
        wind_mph = float(wind) * 2.23694
    else:
        wind_mph = float(wind) * 0.621371
    return {
        "temperature_2m": round(_c_to_f(float(temp)), 1),
        "weather_code": code,
        "wind_speed_10m": None if wind_mph is None else round(wind_mph, 1),
        "is_day": 1 if is_day else 0,
        "source": f"NWS {station}",
        "observedAt": stamp,
    }


def _open_meteo(cfg: dict[str, Any]) -> dict[str, Any]:
    lat = cfg["latitude"]
    lon = cfg["longitude"]
    tz = urllib.parse.quote(str(cfg.get("timezone") or "America/Chicago"))
    url = (
        f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
        "&current=temperature_2m,weather_code,wind_speed_10m,is_day"
        "&minutely_15=temperature_2m,weather_code,is_day"
        "&forecast_minutely_15=8"
        "&daily=weather_code,temperature_2m_max,temperature_2m_min"
        "&temperature_unit=fahrenheit&wind_speed_unit=mph"
        f"&timezone={tz}&forecast_days=4"
    )
    return _weather_http_json(url, timeout=15)


def _latest_minutely(om: dict[str, Any]) -> dict[str, Any] | None:
    minute = om.get("minutely_15") or {}
    temps = minute.get("temperature_2m") or []
    codes = minute.get("weather_code") or []
    days = minute.get("is_day") or []
    for i in range(len(temps) - 1, -1, -1):
        if temps[i] is None:
            continue
        return {
            "temperature_2m": float(temps[i]),
            "weather_code": int(codes[i] if i < len(codes) and codes[i] is not None else 2),
            "is_day": int(days[i] if i < len(days) and days[i] is not None else 1),
            "source": "Open-Meteo 15min",
        }
    return None


def fetch_weather() -> dict[str, Any]:
    now = time.time()
    cached = _weather_cache.get("data")
    if cached and now - float(_weather_cache.get("at") or 0) < WEATHER_CACHE_SEC:
        return cached
    cfg = load_config_weather()
    om = _open_meteo(cfg)
    current = None
    try:
        current = _nws_current(cfg)
    except Exception as exc:  # noqa: BLE001
        print(f"NWS KRPJ observation failed: {exc}", flush=True)
    if current is None:
        current = _latest_minutely(om)
    if current is None:
        cur = om.get("current") or {}
        current = {
            "temperature_2m": cur.get("temperature_2m"),
            "weather_code": cur.get("weather_code"),
            "wind_speed_10m": cur.get("wind_speed_10m"),
            "is_day": cur.get("is_day", 1),
            "source": "Open-Meteo",
        }
    if current.get("wind_speed_10m") is None:
        current["wind_speed_10m"] = (om.get("current") or {}).get("wind_speed_10m")
    payload = {
        "place": cfg["place"],
        "zip": cfg["zip"],
        "station": cfg["station"],
        "latitude": cfg["latitude"],
        "longitude": cfg["longitude"],
        "updatedAt": int(now * 1000),
        "current": current,
        "daily": om.get("daily") or {},
    }
    _weather_cache["at"] = now
    _weather_cache["data"] = payload
    return payload


def _google_http_json(url: str, *, token: str = "", data: bytes | None = None) -> dict[str, Any]:
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            body = ""
        detail = ""
        try:
            parsed = json.loads(body) if body else {}
            err = parsed.get("error")
            if isinstance(err, dict):
                detail = err.get("message") or ""
            elif isinstance(err, str):
                detail = parsed.get("error_description") or err
        except Exception:  # noqa: BLE001
            detail = body[:160]
        raise RuntimeError(detail or f"Google HTTP {exc.code}") from exc


def google_access_token() -> str:
    secrets_map = load_secrets()
    client_id = secrets_map.get("googleClientId") or ""
    client_secret = secrets_map.get("googleClientSecret") or ""
    refresh = secrets_map.get("googleRefreshToken") or ""
    if not (client_id and client_secret and refresh):
        return ""
    now = time.time()
    with _oauth_lock:
        if _oauth_access["token"] and _oauth_access["expires_at"] > now + 60:
            return str(_oauth_access["token"])
        payload = _google_http_json(
            GOOGLE_TOKEN_URL,
            data=urllib.parse.urlencode(
                {
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "refresh_token": refresh,
                    "grant_type": "refresh_token",
                }
            ).encode("utf-8"),
        )
        token = str(payload.get("access_token") or "")
        if not token:
            raise RuntimeError("Google OAuth did not return an access token")
        expires = int(payload.get("expires_in") or 3600)
        _oauth_access["token"] = token
        _oauth_access["expires_at"] = now + expires
        return token


def google_event_color_map(token: str) -> dict[str, str]:
    now = time.time()
    if _oauth_colors["event"] and _oauth_colors["fetched_at"] > now - 86400:
        return dict(_oauth_colors["event"])
    data = _google_http_json(GOOGLE_COLORS_URL, token=token)
    event = {
        str(key): str(value.get("background") or "")
        for key, value in (data.get("event") or {}).items()
        if isinstance(value, dict)
    }
    _oauth_colors["event"] = event
    _oauth_colors["fetched_at"] = now
    return event


def _all_day_end(end_date: str) -> str:
    try:
        year, month, day = [int(part) for part in end_date.split("-")[:3]]
        prev = date(year, month, day) - timedelta(days=1)
        return f"{prev.isoformat()}T23:59:59"
    except Exception:  # noqa: BLE001
        return f"{end_date}T23:59:59"


def fetch_google_calendar_api() -> dict[str, Any] | None:
    if not oauth_calendar_configured():
        return None
    cfg = load_config_calendar()
    calendar_id = cfg.get("calendarId") or ""
    if not calendar_id:
        raise RuntimeError("Missing googleCalendar.calendarId in shared/config.js")
    token = google_access_token()
    colors = google_event_color_map(token)
    cal_url = f"{GOOGLE_CAL_API}/calendars/{urllib.parse.quote(calendar_id, safe='')}"
    calendar = _google_http_json(cal_url, token=token)
    default_color = str(calendar.get("backgroundColor") or "")
    labels = {
        str(label.get("id")): str(label.get("backgroundColor") or "")
        for label in ((calendar.get("labelProperties") or {}).get("eventLabels") or [])
        if isinstance(label, dict) and label.get("id") and label.get("backgroundColor")
    }

    now = datetime.now(timezone.utc)
    time_min = now.isoformat().replace("+00:00", "Z")
    time_max = (now + timedelta(days=int(cfg.get("daysAhead") or 21))).isoformat().replace("+00:00", "Z")
    events: list[dict[str, Any]] = []
    page_token = ""
    while True:
        params = {
            "timeMin": time_min,
            "timeMax": time_max,
            "singleEvents": "true",
            "orderBy": "startTime",
            "maxResults": "250",
            "eventLabelVersion": "1",
        }
        if page_token:
            params["pageToken"] = page_token
        url = f"{cal_url}/events?{urllib.parse.urlencode(params)}"
        data = _google_http_json(url, token=token)
        for item in data.get("items") or []:
            if not isinstance(item, dict):
                continue
            start = item.get("start") or {}
            end = item.get("end") or {}
            all_day = bool(start.get("date") and not start.get("dateTime"))
            start_val = start.get("dateTime") or (f"{start.get('date')}T00:00:00" if start.get("date") else "")
            if all_day and end.get("date"):
                end_val = _all_day_end(str(end.get("date")))
            else:
                end_val = end.get("dateTime") or start_val
            color = (
                labels.get(str(item.get("eventLabelId") or ""))
                or colors.get(str(item.get("colorId") or ""))
                or default_color
            )
            events.append(
                {
                    "id": item.get("id"),
                    "title": item.get("summary") or "(No title)",
                    "start": start_val,
                    "end": end_val,
                    "allDay": all_day,
                    "location": item.get("location") or "",
                    "color": color,
                }
            )
        page_token = str(data.get("nextPageToken") or "")
        if not page_token:
            break
    return {"source": "google-oauth", "events": events}


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


def files_password() -> str:
    return (load_secrets().get("filesPassword") or FILES_PASSWORD_DEFAULT).strip()


def passwords_match(given: str, expected: str) -> bool:
    left = (given or "").encode("utf-8")
    right = (expected or "").encode("utf-8")
    if len(left) != len(right):
        hmac.compare_digest(right, right)
        return False
    return hmac.compare_digest(left, right)


def require_files_access(handler: SimpleHTTPRequestHandler) -> bool:
    if not require_admin(handler):
        return False
    token = (handler.headers.get("X-Files-Token") or "").strip()
    now = time.time()
    expired = [key for key, exp in FILE_SESSIONS.items() if exp <= now]
    for key in expired:
        FILE_SESSIONS.pop(key, None)
    if token and FILE_SESSIONS.get(token, 0) > now:
        FILE_SESSIONS[token] = now + FILE_SESSION_HOURS * 3600
        return True
    send_json(handler, {"error": "File access locked"}, 403)
    return False


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _request_host(self) -> str:
        return (self.headers.get("Host") or "").split(":")[0].strip().lower()

    def _is_public_admin_host(self) -> bool:
        """True for the Cloudflare hostname — LAN/localhost keep the screen picker at /."""
        host = self._request_host()
        if not host or host in {"127.0.0.1", "localhost", "::1"}:
            return False
        if host.endswith(".local"):
            return False
        try:
            ip = ipaddress.ip_address(host)
            return not (ip.is_private or ip.is_loopback or ip.is_link_local)
        except ValueError:
            return True

    def _rewrite_phone_to_admin(self) -> None:
        """Map /phone/* and public / to admin — Cloudflare often blocks /admin/* paths."""
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = ("?" + parsed.query) if parsed.query else ""
        # Serve index directly — avoids 301 redirect loops with Cloudflare edge (trailing slash)
        if path in ("/phone", "/phone/", "/admin", "/admin/"):
            self.path = f"/admin/index.html{query}"
            return
        if path.startswith("/phone/"):
            suffix = path[len("/phone") :]
            self.path = f"/admin{suffix}{query}"
            return

        if not self._is_public_admin_host():
            return
        if path in ("/", "/index.html"):
            self.path = f"/admin/index.html{query}"
            return
        root_admin = {
            "/api.js",
            "/app.js",
            "/admin.css",
            "/fonts.css",
            "/manifest.webmanifest",
            "/sw.js",
        }
        if path in root_admin or path.startswith("/icons/"):
            self.path = f"/admin{path}{query}"

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

    def _public_admin_redirect(self) -> bool:
        """Send the public hostname to /phone/ — Cloudflare blocks /admin/*."""
        if not self._is_public_admin_host():
            return False
        path = urllib.parse.urlparse(self.path).path
        if path in ("/", "/index.html", "/admin", "/admin/", "/admin/index.html"):
            self.send_response(302)
            self.send_header("Location", "/phone/index.html")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return True
        return False

    def do_GET(self):
        if self._public_admin_redirect():
            return
        self._rewrite_phone_to_admin()
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"

        if path == "/api/calendar":
            return self.proxy_calendar()
        if path == "/api/weather":
            try:
                return send_json(self, fetch_weather())
            except Exception as exc:  # noqa: BLE001
                print(f"Weather fetch failed: {exc}", flush=True)
                cached = _weather_cache.get("data")
                if cached:
                    return send_json(self, cached)
                return send_json(self, {"error": "Weather unavailable"}, 502)
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
                        "boot": deploy.boot_status(),
                    },
                    "features": ["settings", "screensaver", "whiteboard", "nightMode", "kioskTheme", "rotation", "liveReload"],
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
        if path == "/api/family/consequences":
            return send_json(self, {"items": db.load_db().get("consequences", [])})
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
        if path == "/api/admin/browse":
            if not require_files_access(self):
                return
            qs = urllib.parse.parse_qs(parsed.query)
            rel = (qs.get("path") or [""])[0]
            try:
                return send_json(self, list_browse_dir(rel))
            except ValueError as exc:
                return send_json(self, {"error": str(exc)}, 400)
            except FileNotFoundError:
                return send_json(self, {"error": "Folder not found"}, 404)
        if path == "/api/admin/browse/file":
            if not require_files_access(self):
                return
            qs = urllib.parse.parse_qs(parsed.query)
            rel = (qs.get("path") or [""])[0]
            try:
                return send_json(self, read_browse_file(rel))
            except ValueError as exc:
                return send_json(self, {"error": str(exc)}, 400)
            except FileNotFoundError:
                return send_json(self, {"error": "File not found"}, 404)
        if path == "/api/admin/files":
            if not require_files_access(self):
                return
            return send_json(
                self,
                {
                    "files": [
                        {
                            "id": fid,
                            "label": meta["label"],
                            "hint": meta["hint"],
                            "rel": meta["rel"],
                            "writable": bool(meta["writable"]),
                            "exists": (ROOT / str(meta["rel"])).is_file(),
                        }
                        for fid, meta in ADMIN_FILES.items()
                    ]
                },
            )
        if path.startswith("/api/admin/files/"):
            if not require_files_access(self):
                return
            file_id = path.rsplit("/", 1)[-1]
            try:
                return send_json(self, read_admin_file(file_id))
            except FileNotFoundError:
                return send_json(self, {"error": "Unknown file"}, 404)
        if path in {"/shared/secrets.local.js", "/shared/secrets.local.js/"}:
            return send_json(self, {"error": "Not found"}, 404)

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
        if path == "/api/family/lists/clear-completed":
            if not require_admin(self):
                return
            return self.list_clear_completed(payload)
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
        if path == "/api/family/consequences/apply":
            if not require_admin(self):
                return
            return self.consequence_apply(payload)
        if path == "/api/family/consequences":
            if not require_admin(self):
                return
            return self.consequences_upsert(payload)
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

        if path == "/api/admin/reboot":
            if not require_admin(self):
                return
            return self.admin_reboot()

        if path == "/api/admin/tunnel-start":
            if not require_admin(self):
                return
            return self.admin_tunnel_start()
        if path == "/api/admin/files/unlock":
            if not require_admin(self):
                return
            return self.files_unlock(payload)
        if path == "/api/admin/browse/file":
            if not require_files_access(self):
                return
            try:
                saved = write_browse_file(str(payload.get("path") or ""), str(payload.get("content") or ""))
            except FileNotFoundError:
                return send_json(self, {"error": "File not found"}, 404)
            except PermissionError as exc:
                return send_json(self, {"error": str(exc)}, 403)
            except ValueError as exc:
                return send_json(self, {"error": str(exc)}, 400)
            return send_json(self, saved)
        if path.startswith("/api/admin/files/"):
            if not require_files_access(self):
                return
            file_id = path.rsplit("/", 1)[-1]
            try:
                saved = write_admin_file(file_id, str(payload.get("content") or ""))
            except FileNotFoundError:
                return send_json(self, {"error": "Unknown file"}, 404)
            except PermissionError as exc:
                return send_json(self, {"error": str(exc)}, 403)
            except ValueError as exc:
                return send_json(self, {"error": str(exc)}, 400)
            return send_json(self, saved)

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
            for cons in state.get("consequences", []):
                kid_ids = cons.get("kidIds") or []
                if kid_id in kid_ids:
                    cons["kidIds"] = [x for x in kid_ids if x != kid_id]
            state["consequenceHits"] = [
                hit for hit in (state.get("consequenceHits") or []) if hit.get("kidId") != kid_id
            ]
            state["starLog"] = [row for row in (state.get("starLog") or []) if row.get("kidId") != kid_id]
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
        if path.startswith("/api/family/consequences/"):
            cons_id = path.split("/")[-1]
            state["consequences"] = [c for c in state.get("consequences", []) if c.get("id") != cons_id]
            db.save_db(state)
            return send_json(self, {"ok": True, "state": db.public_state(state)})
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

    def files_unlock(self, payload: dict):
        if not passwords_match(str(payload.get("password") or ""), files_password()):
            return send_json(self, {"error": "Wrong password"}, 403)
        token = secrets.token_urlsafe(24)
        FILE_SESSIONS[token] = time.time() + FILE_SESSION_HOURS * 3600
        return send_json(self, {"ok": True, "filesToken": token})

    # ---- calendar ----
    def _is_ics_payload(self, data: bytes) -> bool:
        if not data:
            return False
        sample = data[:4000].lstrip(b"\xef\xbb\xbf \t\r\n")
        return b"BEGIN:VCALENDAR" in sample or b"BEGIN:VEVENT" in data

    def _write_calendar_bytes(self, data: bytes, *, cached: bool = False) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/calendar; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        if cached:
            self.send_header("X-Family-Calendar-Cache", "1")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _write_calendar_json(self, payload: dict[str, Any], *, cached: bool = False) -> None:
        if not cached:
            try:
                CAL_JSON_CACHE.parent.mkdir(parents=True, exist_ok=True)
                CAL_JSON_CACHE.write_text(json.dumps(payload), encoding="utf-8")
            except OSError:
                pass
        send_json(self, {**payload, "cached": True} if cached else payload)

    def _cached_calendar_json(self) -> bool:
        if not CAL_JSON_CACHE.exists():
            return False
        try:
            payload = json.loads(CAL_JSON_CACHE.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return False
        if not isinstance(payload, dict) or not isinstance(payload.get("events"), list):
            return False
        self._write_calendar_json(payload, cached=True)
        return True

    def proxy_calendar(self):
        if oauth_calendar_configured():
            try:
                payload = fetch_google_calendar_api()
                if payload is not None:
                    return self._write_calendar_json(payload)
            except Exception as exc:  # noqa: BLE001
                print(f"Calendar OAuth failed, falling back to iCal: {exc}", flush=True)
                if self._cached_calendar_json():
                    return

        ics_url = (load_secrets().get("icsUrl") or "").strip()
        if not ics_url:
            cached = CAL_CACHE.read_bytes() if CAL_CACHE.exists() else b""
            if self._is_ics_payload(cached):
                return self._write_calendar_bytes(cached, cached=True)
            return send_json(
                self,
                {
                    "error": "Missing icsUrl in shared/secrets.local.js (gitignored — copy it onto the Pi)",
                },
                500,
            )

        candidates = [ics_url]
        # Google accepts either %40 or @ in the calendar id segment
        if "%40" in ics_url:
            candidates.append(ics_url.replace("%40", "@"))
        elif "@" in ics_url and "/calendar/ical/" in ics_url:
            candidates.append(ics_url.replace("@", "%40"))

        live_error = ""
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
            "Accept": "text/calendar, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
        }

        for candidate in candidates:
            try:
                req = urllib.request.Request(candidate, headers=headers)
                with urllib.request.urlopen(req, timeout=30) as resp:
                    data = resp.read()
                if self._is_ics_payload(data):
                    try:
                        CAL_CACHE.parent.mkdir(parents=True, exist_ok=True)
                        CAL_CACHE.write_bytes(data)
                    except OSError:
                        pass
                    return self._write_calendar_bytes(data)
                live_error = (
                    "icsUrl did not return a Google iCal feed — open Google Calendar → "
                    "Settings → Integrate calendar → copy a fresh Secret address in iCal format"
                )
            except urllib.error.HTTPError as exc:
                body = ""
                try:
                    body = exc.read().decode("utf-8", errors="replace")[:180]
                except Exception:  # noqa: BLE001
                    body = ""
                live_error = f"Google iCal HTTP {exc.code}"
                if exc.code in (400, 401, 403, 404):
                    live_error += (
                        " — secret iCal URL is invalid or was reset. "
                        "Paste a new Secret address into shared/secrets.local.js"
                    )
                if body and "Error" in body:
                    live_error += f" ({body.strip()[:80]})"
            except Exception as exc:  # noqa: BLE001
                live_error = f"Calendar fetch failed: {exc}"

        cached = CAL_CACHE.read_bytes() if CAL_CACHE.exists() else b""
        if self._is_ics_payload(cached):
            return self._write_calendar_bytes(cached, cached=True)

        send_json(self, {"error": live_error or "Google Calendar unavailable"}, 502)

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
        if "icon" in payload:
            icon = str(payload.get("icon") or "").strip()
        else:
            icon = str(existing.get("icon") or "").strip()
        if "stars" in payload and payload.get("stars") not in (None, ""):
            stars = db.clamp_int(payload.get("stars"), 1, 0, 99)
        else:
            stars = db.clamp_int(existing.get("stars"), 1, 0, 99)
        chore = {
            "id": payload.get("id") or new_id("chore"),
            "title": (payload.get("title") or existing.get("title") or "Chore").strip(),
            "icon": icon,
            "stars": stars,
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

    def consequences_upsert(self, payload: dict):
        state = db.load_db()
        rows = state.setdefault("consequences", [])
        existing = next((row for row in rows if row.get("id") == payload.get("id")), {})
        item = {
            "id": payload.get("id") or new_id("cons"),
            "title": (payload.get("title") or existing.get("title") or "Consequence").strip(),
            "icon": payload.get("icon") or existing.get("icon") or "⚠️",
            "stars": max(1, min(99, int(payload.get("stars") or existing.get("stars") or 1))),
            "kidIds": payload.get("kidIds")
            if payload.get("kidIds") is not None
            else (existing.get("kidIds") or []),
            "hint": (
                payload.get("hint")
                if payload.get("hint") is not None
                else (existing.get("hint") or "")
            ).strip(),
            "active": payload.get("active", existing.get("active", True)),
        }
        for i, row in enumerate(rows):
            if row.get("id") == item["id"]:
                rows[i] = {**row, **item}
                break
        else:
            rows.append(item)
        db.save_db(state)
        send_json(self, {"item": item, "state": db.public_state(state)})

    def consequence_apply(self, payload: dict):
        state = db.load_db()
        cons_id = payload.get("id") or payload.get("consequenceId")
        item = next((row for row in state.get("consequences", []) if row.get("id") == cons_id), None)
        if not item:
            return send_json(self, {"error": "Consequence not found"}, 404)
        kid_ids = payload.get("kidIds") if payload.get("kidIds") is not None else (item.get("kidIds") or [])
        kid_ids = [kid for kid in kid_ids if kid]
        if not kid_ids:
            return send_json(self, {"error": "Assign at least one kid"}, 400)
        stars = max(1, min(99, int(item.get("stars") or 1)))
        stamped = db.now_ms()
        day = db.today_key()
        bal = state.setdefault("balances", {})
        hits = state.setdefault("consequenceHits", [])
        applied = []
        for kid_id in kid_ids:
            bal[kid_id] = max(0, int(bal.get(kid_id) or 0) - stars)
            hit = {
                "id": new_id("hit"),
                "consequenceId": item["id"],
                "kidId": kid_id,
                "title": item.get("title") or "Consequence",
                "icon": item.get("icon") or "⚠️",
                "stars": stars,
                "hint": item.get("hint") or "",
                "at": stamped,
            }
            hits.append(hit)
            db.append_star_log(
                state,
                kidId=kid_id,
                type="consequence",
                title=item.get("title") or "Consequence",
                icon=item.get("icon") or "⚠️",
                stars=-stars,
                at=stamped,
                day=day,
                ref=f"cons:{item['id']}:{hit['id']}",
            )
            applied.append(hit)
        state["consequenceHits"] = db.recent_consequence_hits(state)
        db.save_db(state)
        send_json(self, {"ok": True, "applied": applied, "state": db.public_state(state)})

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
        if delta:
            db.append_star_log(
                state,
                kidId=kid_id,
                type="adjust",
                title="Star adjustment",
                icon="⭐",
                stars=delta,
                ref=f"adjust:{db.now_ms()}",
            )
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
        now = int(time.time() * 1000)
        for item in items:
            if item.get("id") == item_id:
                if item.get("done"):
                    item["done"] = False
                    item.pop("completedAt", None)
                    completed = False
                else:
                    item["done"] = True
                    item["completedAt"] = now
                    completed = True
                db.save_db(state)
                return send_json(
                    self,
                    {
                        "removed": False,
                        "completed": completed,
                        "itemId": item_id,
                        "item": item,
                        "state": db.public_state(state),
                    },
                )
        send_json(self, {"error": "Item not found"}, 404)

    def list_clear_completed(self, payload: dict):
        state = db.load_db()
        name = payload.get("name")
        if name not in ("grocery", "reminders"):
            return send_json(self, {"error": "Invalid list"}, 400)
        items = state.setdefault("lists", {}).setdefault(name, [])
        state["lists"][name] = [i for i in items if not (isinstance(i, dict) and i.get("done"))]
        db.save_db(state)
        send_json(self, {"ok": True, "state": db.public_state(state)})

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
        if "kioskTheme" in payload:
            settings["kioskTheme"] = "day" if payload.get("kioskTheme") == "day" else "night"
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
            db.remove_star_log(state, ref=f"chore:{chore_id}", kid_id=kid_id, day=day)
            done = False
            stars_earned = 0
            late = False
        else:
            stars_earned, late = db.chore_stars_for_now(chore)
            stamped = db.now_ms()
            bucket[key] = {"stars": stars_earned, "late": late, "at": stamped}
            bal[kid_id] += stars_earned
            db.append_star_log(
                state,
                kidId=kid_id,
                type="chore",
                title=chore.get("title") or "Chore",
                icon=chore.get("icon") or "",
                stars=stars_earned,
                late=late,
                at=stamped,
                day=day,
                ref=f"chore:{chore_id}",
            )
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
        stamped = db.now_ms()
        redeem_id = new_id("redeem")
        state.setdefault("redemptions", []).insert(
            0,
            {
                "id": redeem_id,
                "kidId": kid_id,
                "kidName": kid.get("name") or kid_id,
                "rewardId": reward_id,
                "title": reward.get("title"),
                "icon": reward.get("icon"),
                "cost": cost,
                "at": stamped,
            },
        )
        db.append_star_log(
            state,
            kidId=kid_id,
            type="redeem",
            title=reward.get("title") or "Reward",
            icon=reward.get("icon") or "🎁",
            stars=-cost,
            at=stamped,
            ref=f"redeem:{redeem_id}",
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

    def admin_reboot(self):
        result = deploy.schedule_pi_reboot()
        status = 200 if result.get("ok") else 400
        send_json(self, result, status)

    def admin_tunnel_start(self):
        result = deploy.enable_boot_services()
        status = 200 if result.get("ok") else 400
        send_json(self, {**result, "boot": result.get("services") or deploy.boot_status()}, status)

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
    print(f"Calendar API  -> http://127.0.0.1:{PORT}/api/calendar", flush=True)
    print(f"Root          -> {ROOT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.", flush=True)
        server.server_close()
