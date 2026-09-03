"""Family Board JSON database (local now → Cloudflare later)."""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from copy import deepcopy
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "family.json"
_lock = threading.Lock()
_cache_state: dict[str, Any] | None = None
_cache_mtime: float = 0.0
_cache_revision: int = 0


def _sync_cache_revision(state: dict[str, Any]) -> None:
    global _cache_revision
    _cache_revision = int((state.get("meta") or {}).get("revision") or 0)


def _id(prefix: str = "id") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def default_state() -> dict[str, Any]:
    kids = [
        {"id": "maya", "name": "Maya", "emoji": "🦎", "color": "#3ecf8e", "active": True},
        {"id": "leo", "name": "Leo", "emoji": "🚀", "color": "#3aa0e8", "active": True},
        {"id": "zoe", "name": "Zoe", "emoji": "🌈", "color": "#e85d9a", "active": True},
        {"id": "sam", "name": "Sam", "emoji": "⚡", "color": "#f5c84c", "active": True},
        {"id": "ava", "name": "Ava", "emoji": "🦄", "color": "#ff7a59", "active": True},
        {"id": "max", "name": "Max", "emoji": "🦖", "color": "#2dd4bf", "active": True},
    ]

    by_kid = {
        "maya": ["bed", "pets", "dishes", "homework", "tidy"],
        "leo": ["bed", "trash", "reading", "shoes", "plants"],
        "zoe": ["bed", "table", "homework", "tidy", "laundry"],
        "sam": ["bed", "trash", "shoes", "reading", "dishes"],
        "ava": ["bed", "pets", "table", "tidy", "homework"],
        "max": ["bed", "plants", "shoes", "bathroom", "reading"],
    }

    catalog = {
        "bed": ("Make bed", "🛏️", 1, "morning", "Before school — pull covers neat"),
        "dishes": ("Clear dishes", "🍽️", 2, "evening", "After dinner"),
        "tidy": ("10-min tidy", "🧸", 2, "afternoon", "Afternoon reset"),
        "homework": ("Homework ready", "📚", 1, "afternoon", "Before bedtime"),
        "trash": ("Trash run", "🗑️", 2, "evening", "Take kitchen bin out"),
        "pets": ("Feed pets", "🐾", 2, "morning", "Food + water"),
        "plants": ("Water plants", "🌱", 1, "morning", "Kitchen window"),
        "laundry": ("Laundry helper", "👕", 2, "afternoon", "Bring basket down"),
        "shoes": ("Shoes by door", "👟", 1, "morning", "Pairs lined up"),
        "reading": ("Reading time", "📖", 1, "evening", "15 minutes before bed"),
        "table": ("Set the table", "🍴", 2, "evening", "Before dinner"),
        "bathroom": ("Bathroom wipe", "✨", 2, "afternoon", "Sink sparkle"),
    }
    chores = []
    for kid_id, keys in by_kid.items():
        for key in keys:
            title, icon, stars, period, hint = catalog[key]
            chores.append(
                {
                    "id": _id("chore"),
                    "key": key,
                    "title": title,
                    "icon": icon,
                    "stars": stars,
                    "hint": hint,
                    "kidIds": [kid_id],
                    "period": period,
                    "dueTime": {"morning": "12:00", "afternoon": "17:00", "evening": "21:00"}.get(period, ""),
                    "repeat": "daily",
                    "interval": "daily",
                    "intervalDays": [],
                    "intervalAnchor": "",
                    "active": True,
                }
            )

    return {
        "version": 1,
        "meta": {"revision": 0},
        "kids": kids,
        "chores": chores,
        "balances": {k["id"]: 0 for k in kids},
        "completions": {},
        "lists": {
            "grocery": [
                {"id": _id("item"), "text": t, "done": False}
                for t in ["Milk", "Bread", "Eggs", "Bananas", "Chicken", "Yogurt"]
            ],
            "reminders": [
                {"id": _id("item"), "text": t, "done": False}
                for t in [
                    "Permission slips due Friday",
                    "Trash/recycling night",
                    "Pay soccer fees",
                    "Call dentist to confirm",
                ]
            ],
        },
        "rewards": [
            {"id": "screen15", "title": "15 min extra screen", "cost": 8, "icon": "📱", "active": True},
            {"id": "dessert", "title": "Pick dessert", "cost": 10, "icon": "🍦", "active": True},
            {"id": "stayup", "title": "Stay up 30 min late", "cost": 12, "icon": "🌙", "active": True},
            {"id": "game", "title": "Choose family game", "cost": 14, "icon": "🎲", "active": True},
            {"id": "movie", "title": "Pick movie night", "cost": 16, "icon": "🎬", "active": True},
            {"id": "dinner", "title": "Pick dinner night", "cost": 18, "icon": "🍕", "active": True},
            {"id": "park", "title": "Park trip vote", "cost": 20, "icon": "🏞️", "active": True},
            {"id": "friend", "title": "Friend playdate", "cost": 22, "icon": "🎉", "active": True},
        ],
        "redemptions": [],
        "consequences": [],
        "consequenceHits": [],
        "bonusHits": [],
        "starLog": [],
        "whiteboard": {"version": 1, "strokes": [], "updatedAt": 0},
        "screensaverPhotos": [],
        "settings": {
            "allDoneBonus": 3,
            "familyName": "Family Board",
            "rotation": {
                "pauseOnTouchSeconds": 120,
                "screens": {
                    "calendar": {"enabled": True, "seconds": 45},
                    "chores": {"enabled": True, "seconds": 45},
                    "rewards": {"enabled": True, "seconds": 45},
                    "whiteboard": {"enabled": True, "seconds": 45},
                },
            },
            "kioskTheme": "night",
            "nightMode": {
                "enabled": False,
                "dimTime": "22:00",
                "brightTime": "06:00",
                "brightness": 15,
            },
            "screensaver": {
                "enabled": False,
                "idleMinutes": 5,
                "slideSeconds": 12,
                "scheduleEnabled": False,
                "startTime": "22:00",
                "endTime": "06:00",
                "activeAlbumIds": ["nature"],
                "sources": [],
            },
        },
    }


def _load_unlocked() -> dict[str, Any]:
    global _cache_state, _cache_mtime
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not DATA_PATH.exists():
        state = default_state()
        DATA_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")
        _cache_state = deepcopy(state)
        _cache_mtime = DATA_PATH.stat().st_mtime
        _sync_cache_revision(_cache_state)
        return deepcopy(state)
    try:
        mtime = DATA_PATH.stat().st_mtime
        if _cache_state is not None and mtime == _cache_mtime:
            return deepcopy(_cache_state)
        raw = DATA_PATH.read_text(encoding="utf-8")
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("family.json root must be an object")
        _cache_state = data
        _cache_mtime = mtime
        _sync_cache_revision(_cache_state)
        return deepcopy(data)
    except (json.JSONDecodeError, ValueError, OSError) as exc:
        # Keep a backup and reseeds so the server can still boot on Pi
        backup = DATA_PATH.with_suffix(f".bad-{int(time.time())}.json")
        try:
            DATA_PATH.replace(backup)
        except OSError:
            backup = None
        state = default_state()
        DATA_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")
        _cache_state = deepcopy(state)
        _cache_mtime = DATA_PATH.stat().st_mtime
        _sync_cache_revision(_cache_state)
        print(
            f"[db] WARNING: could not read {DATA_PATH} ({exc}). "
            f"Re-seeded defaults"
            + (f"; backup at {backup}" if backup else "")
            + ".",
            flush=True,
        )
        return deepcopy(state)


def bump_revision(state: dict[str, Any]) -> None:
    state.setdefault("meta", {})["revision"] = int(time.time() * 1000)


def _save_unlocked(state: dict[str, Any]) -> dict[str, Any]:
    global _cache_state, _cache_mtime
    bump_revision(state)
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = DATA_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    tmp.replace(DATA_PATH)
    _cache_state = deepcopy(state)
    _cache_mtime = DATA_PATH.stat().st_mtime
    _sync_cache_revision(_cache_state)
    return deepcopy(state)


def load_db() -> dict[str, Any]:
    with _lock:
        return _load_unlocked()


def peek_revision() -> int:
    with _lock:
        if _cache_state is None:
            _load_unlocked()
        return _cache_revision


def get_lists_snapshot() -> dict[str, Any]:
    with _lock:
        if _cache_state is None:
            _load_unlocked()
        lists = (_cache_state or {}).get("lists") or {}
        return {"revision": _cache_revision, "lists": deepcopy(lists)}


def lists_public(state: dict[str, Any]) -> dict[str, Any]:
    return deepcopy(state.get("lists") or {})


def get_revision(state: dict[str, Any] | None = None) -> int:
    if state is not None:
        return int((state.get("meta") or {}).get("revision") or 0)
    return peek_revision()


def save_db(state: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        return _save_unlocked(state)


def mutate_db(mutator: Callable[[dict[str, Any]], Any]) -> tuple[Any, dict[str, Any]]:
    """Load, mutate, and save under one lock so concurrent writes cannot clobber a grocery add."""
    with _lock:
        state = _load_unlocked()
        result = mutator(state)
        saved = _save_unlocked(state)
        return result, saved


CHORE_PERIOD_DEADLINE = {
    "morning": (12, 0),
    "afternoon": (17, 0),
    "evening": (21, 0),
}
PERIOD_TO_TIME = {
    "morning": "12:00",
    "afternoon": "17:00",
    "evening": "21:00",
}


def parse_due_time(value: Any) -> str:
    """Return HH:MM (24h) or empty if there is no deadline."""
    text = str(value or "").strip().lower()
    if not text or text in ("chore", "anytime", "none", "n/a"):
        return ""
    match = re.match(r"^(\d{1,2}):(\d{2})\s*(am|pm)?$", text)
    if not match:
        return ""
    hour = int(match.group(1))
    minute = int(match.group(2))
    ampm = match.group(3) or ""
    if minute > 59:
        return ""
    if ampm == "pm" and hour < 12:
        hour += 12
    elif ampm == "am" and hour == 12:
        hour = 0
    if hour > 23:
        return ""
    return f"{hour:02d}:{minute:02d}"


def chore_due_time(chore: dict[str, Any]) -> str:
    parsed = parse_due_time(chore.get("dueTime"))
    if parsed:
        return parsed
    return PERIOD_TO_TIME.get(str(chore.get("period") or ""), "")


def due_time_minutes(value: Any) -> int | None:
    parsed = chore_due_time(value) if isinstance(value, dict) else parse_due_time(value)
    if not parsed:
        return None
    hour, minute = [int(part) for part in parsed.split(":")]
    return hour * 60 + minute


def format_due_time(value: Any) -> str:
    parsed = chore_due_time(value) if isinstance(value, dict) else parse_due_time(value)
    if not parsed:
        return ""
    hour, minute = [int(part) for part in parsed.split(":")]
    suffix = "AM" if hour < 12 else "PM"
    hour12 = hour % 12 or 12
    return f"{hour12}:{minute:02d} {suffix}"


def clamp_int(value: Any, default: int = 0, lo: int = 0, hi: int = 99) -> int:
    if value is None or value == "":
        n = default
    else:
        try:
            n = int(value)
        except (TypeError, ValueError):
            n = default
    return max(lo, min(hi, n))


def normalize_chore_icon(value: Any) -> str:
    icon = str(value or "").strip()
    if icon.lower() in ("", "none", "null", "undefined", "-", "—"):
        return ""
    return icon


def chore_star_value(chore: dict[str, Any], default: int = 1) -> int:
    return clamp_int(chore.get("stars"), default, 0, 99)


def late_star_value(chore: dict[str, Any]) -> int:
    """Stars earned after the due time. Blank lateStars keeps the old half-price default."""
    base = chore_star_value(chore)
    raw = chore.get("lateStars") if isinstance(chore, dict) else None
    if raw in (None, ""):
        if base <= 0:
            return 0
        return max(1, base // 2)
    return clamp_int(raw, 0, 0, 99)


def chore_stars_for_now(chore: dict[str, Any], when=None) -> tuple[int, bool]:
    base = chore_star_value(chore)
    dead_mins = due_time_minutes(chore)
    if dead_mins is None:
        return base, False
    now = when or datetime.now()
    now_mins = now.hour * 60 + now.minute
    if now_mins > dead_mins:
        return late_star_value(chore), True
    return base, False


def completion_stars(entry: Any, chore: dict[str, Any]) -> int:
    if entry is True:
        return chore_star_value(chore)
    if isinstance(entry, dict):
        if "stars" in entry and entry.get("stars") not in (None, ""):
            return clamp_int(entry.get("stars"), 0, 0, 99)
        return chore_star_value(chore)
    if isinstance(entry, (int, float)):
        return clamp_int(entry, 0, 0, 99)
    return 0


def today_key() -> str:
    return date.today().isoformat()


INTERVAL_KINDS = ("daily", "everyOther", "weekdays", "weekends", "days")
_INTERVAL_ALIASES = {
    "every-other": "everyOther",
    "every_other": "everyOther",
    "everyother": "everyOther",
    "weekday": "weekdays",
    "weekend": "weekends",
    "weekly": "days",
    "specific": "days",
    "chore": "daily",
}


def js_weekday(day: date) -> int:
    """Sunday=0 … Saturday=6, matching JavaScript Date#getDay()."""
    return (day.weekday() + 1) % 7


def parse_day(day: Any = None) -> date:
    if isinstance(day, datetime):
        return day.date()
    if isinstance(day, date):
        return day
    if isinstance(day, str) and len(day) >= 10:
        try:
            return date.fromisoformat(day[:10])
        except ValueError:
            pass
    return date.today()


def normalize_interval(
    payload: dict[str, Any] | None = None,
    existing: dict[str, Any] | None = None,
) -> tuple[str, list[int], str]:
    payload = payload or {}
    existing = existing or {}
    raw = str(
        payload.get("interval")
        or payload.get("repeat")
        or existing.get("interval")
        or existing.get("repeat")
        or "daily"
    ).strip()
    interval = _INTERVAL_ALIASES.get(raw, raw)
    if interval not in INTERVAL_KINDS:
        interval = "daily"

    days_src = payload.get("intervalDays")
    if days_src is None:
        days_src = existing.get("intervalDays") or []
    days: list[int] = []
    if isinstance(days_src, (list, tuple)):
        for item in days_src:
            try:
                n = int(item)
            except (TypeError, ValueError):
                continue
            if 0 <= n <= 6 and n not in days:
                days.append(n)
        days.sort()

    anchor = str(payload.get("intervalAnchor") or existing.get("intervalAnchor") or "").strip()[:10]
    if interval == "everyOther" and not anchor:
        anchor = today_key()
    return interval, days, anchor


def chore_due_on(chore: dict[str, Any], day: Any = None) -> bool:
    when = parse_day(day)
    interval = str(chore.get("interval") or chore.get("repeat") or "daily")
    if interval in ("daily", "chore", ""):
        return True
    wd = js_weekday(when)
    if interval == "weekdays":
        return wd in (1, 2, 3, 4, 5)
    if interval == "weekends":
        return wd in (0, 6)
    if interval in ("days", "weekly"):
        days: list[int] = []
        for item in chore.get("intervalDays") or []:
            try:
                n = int(item)
            except (TypeError, ValueError):
                continue
            if 0 <= n <= 6:
                days.append(n)
        if not days:
            return True
        return wd in days
    if interval in ("everyOther", "every-other", "every_other"):
        anchor_raw = str(chore.get("intervalAnchor") or "")[:10]
        try:
            anchor = date.fromisoformat(anchor_raw)
        except ValueError:
            return True
        return (when - anchor).days % 2 == 0
    return True


CONSEQUENCE_TTL_MS = 24 * 60 * 60 * 1000
REDEMPTION_TTL_MS = 48 * 60 * 60 * 1000
STAR_LOG_MAX = 2500


def now_ms() -> int:
    return int(time.time() * 1000)


def day_noon_ms(day: str) -> int:
    try:
        year, month, day_n = [int(part) for part in day.split("-")[:3]]
        return int(datetime(year, month, day_n, 12, 0).timestamp() * 1000)
    except Exception:  # noqa: BLE001
        return now_ms()


def append_star_log(state: dict[str, Any], **entry: Any) -> dict[str, Any]:
    log = state.setdefault("starLog", [])
    row = {
        "id": entry.get("id") or _id("log"),
        "kidId": entry.get("kidId") or "",
        "type": entry.get("type") or "chore",
        "title": entry.get("title") or "",
        "icon": entry.get("icon") or "",
        "stars": int(entry.get("stars") or 0),
        "late": bool(entry.get("late")),
        "at": int(entry.get("at") or now_ms()),
        "day": entry.get("day") or today_key(),
        "ref": entry.get("ref") or "",
    }
    log.append(row)
    if len(log) > STAR_LOG_MAX:
        state["starLog"] = log[-2000:]
    return row


def remove_star_log(state: dict[str, Any], *, ref: str, kid_id: str, day: str) -> None:
    log = state.get("starLog") or []
    state["starLog"] = [
        row
        for row in log
        if not (row.get("ref") == ref and row.get("kidId") == kid_id and row.get("day") == day)
    ]


def undo_star_log_entry(state: dict[str, Any], log_id: str) -> dict[str, Any]:
    """Remove one receipt line. Star balances stay the same."""
    log = state.get("starLog") or []
    row = next((item for item in log if item.get("id") == log_id), None)
    if not row:
        return {"error": "Receipt line not found", "status": 404}
    state["starLog"] = [item for item in log if item.get("id") != log_id]
    return {"ok": True, "removed": row}


def clear_extra_hits(state: dict[str, Any], hit_id: str | None = None) -> int:
    """Take extras off the chore board. Does not change star balances."""
    removed = 0
    for key in ("bonusHits", "consequenceHits"):
        rows = state.get(key) or []
        if hit_id:
            kept = [hit for hit in rows if hit.get("id") != hit_id]
        else:
            kept = []
        removed += len(rows) - len(kept)
        state[key] = kept
    return removed


def extra_kind(item: dict[str, Any] | None, default: str = "bad") -> str:
    raw = str((item or {}).get("tone") or (item or {}).get("kind") or "").strip().lower()
    if raw in ("good", "bonus", "positive", "reward"):
        return "good"
    if raw in ("bad", "consequence", "negative", "penalty"):
        return "bad"
    return "good" if default == "good" else "bad"


def recent_consequence_hits(state: dict[str, Any]) -> list[dict[str, Any]]:
    cutoff = now_ms() - CONSEQUENCE_TTL_MS
    return [hit for hit in (state.get("consequenceHits") or []) if int(hit.get("at") or 0) >= cutoff]


def recent_bonus_hits(state: dict[str, Any]) -> list[dict[str, Any]]:
    cutoff = now_ms() - CONSEQUENCE_TTL_MS
    return [hit for hit in (state.get("bonusHits") or []) if int(hit.get("at") or 0) >= cutoff]


def recent_redemptions(state: dict[str, Any]) -> list[dict[str, Any]]:
    cutoff = now_ms() - REDEMPTION_TTL_MS
    return [row for row in (state.get("redemptions") or []) if int(row.get("at") or 0) >= cutoff]


def prune_redemptions(state: dict[str, Any]) -> bool:
    kept = recent_redemptions(state)
    if len(kept) == len(state.get("redemptions") or []):
        return False
    state["redemptions"] = kept
    return True


def rollover_completions(state: dict[str, Any]) -> bool:
    """Drop completed-chore display buckets when the calendar day changes."""
    today = today_key()
    meta = state.setdefault("meta", {})
    if meta.get("lastChoreDay") == today:
        return False
    completions = state.get("completions") or {}
    if isinstance(completions, dict):
        state["completions"] = {key: value for key, value in completions.items() if key == today}
    meta["lastChoreDay"] = today
    return True


def migrate_star_log(state: dict[str, Any]) -> bool:
    if "starLog" in state:
        return False
    chores = {chore.get("id"): chore for chore in (state.get("chores") or [])}
    log: list[dict[str, Any]] = []
    for day, bucket in (state.get("completions") or {}).items():
        if not isinstance(bucket, dict):
            continue
        at = day_noon_ms(str(day))
        for key, entry in bucket.items():
            if ":" not in str(key):
                continue
            chore_id, kid_id = str(key).rsplit(":", 1)
            chore = chores.get(chore_id) or {}
            stars = completion_stars(entry, chore)
            late = bool(isinstance(entry, dict) and entry.get("late"))
            log.append(
                {
                    "id": _id("log"),
                    "kidId": kid_id,
                    "type": "chore",
                    "title": chore.get("title") or "Chore",
                    "icon": chore.get("icon") or "",
                    "stars": stars,
                    "late": late,
                    "at": int(entry.get("at") or at) if isinstance(entry, dict) else at,
                    "day": str(day),
                    "ref": f"chore:{chore_id}",
                }
            )
    for redeem in state.get("redemptions") or []:
        if not isinstance(redeem, dict):
            continue
        log.append(
            {
                "id": redeem.get("id") or _id("log"),
                "kidId": redeem.get("kidId") or "",
                "type": "redeem",
                "title": redeem.get("title") or "Reward",
                "icon": redeem.get("icon") or "🎁",
                "stars": -int(redeem.get("cost") or 0),
                "late": False,
                "at": int(redeem.get("at") or now_ms()),
                "day": datetime.fromtimestamp(int(redeem.get("at") or now_ms()) / 1000).date().isoformat()
                if redeem.get("at")
                else today_key(),
                "ref": f"redeem:{redeem.get('id') or ''}",
            }
        )
    log.sort(key=lambda row: int(row.get("at") or 0))
    state["starLog"] = log
    return True


def prepare_state(state: dict[str, Any]) -> bool:
    dirty = False
    if "consequences" not in state:
        state["consequences"] = []
        dirty = True
    if "consequenceHits" not in state:
        state["consequenceHits"] = []
        dirty = True
    if "bonusHits" not in state:
        state["bonusHits"] = []
        dirty = True
    if migrate_star_log(state):
        dirty = True
    if rollover_completions(state):
        dirty = True
    if prune_redemptions(state):
        dirty = True
    return dirty


KIOSK_SCREEN_IDS = ("calendar", "chores", "rewards", "whiteboard")


def default_rotation_screens() -> dict[str, dict[str, Any]]:
    return {sid: {"enabled": True, "seconds": 45} for sid in KIOSK_SCREEN_IDS}


def merged_rotation(raw: dict[str, Any] | None) -> dict[str, Any]:
    defaults = default_state()["settings"]["rotation"]
    rot = {**defaults, **(raw or {})}
    saved = (raw or {}).get("screens") or {}
    default_screens = defaults.get("screens") or default_rotation_screens()
    merged: dict[str, dict[str, Any]] = {}
    for sid in KIOSK_SCREEN_IDS:
        src = {**default_screens.get(sid, {"enabled": True, "seconds": 45}), **(saved.get(sid) or {})}
        merged[sid] = {
            "enabled": bool(src.get("enabled", True)),
            "seconds": max(5, min(600, int(src.get("seconds", 45)))),
        }
    rot["screens"] = merged
    rot["pauseOnTouchSeconds"] = max(0, min(600, int(rot.get("pauseOnTouchSeconds", 120))))
    return rot


def merged_settings(state: dict[str, Any]) -> dict[str, Any]:
    defaults = default_state()["settings"]
    settings = {**defaults, **(state.get("settings") or {})}
    settings["nightMode"] = {
        **defaults["nightMode"],
        **(settings.get("nightMode") or {}),
    }
    settings["screensaver"] = {
        **defaults["screensaver"],
        **(settings.get("screensaver") or {}),
    }
    ss = settings["screensaver"]
    ss["sources"] = list(ss.get("sources") or [])
    raw_ss = (state.get("settings") or {}).get("screensaver") or {}
    if "activeAlbumIds" in raw_ss:
        ss["activeAlbumIds"] = list(ss.get("activeAlbumIds") or [])
    elif "activeAlbumIds" in ss:
        del ss["activeAlbumIds"]
    if ss.get("enabled") and int(ss.get("idleMinutes") or 0) == 0 and not ss.get("scheduleEnabled"):
        ss["idleMinutes"] = 5
    settings["rotation"] = merged_rotation((state.get("settings") or {}).get("rotation"))
    settings["kioskTheme"] = "day" if settings.get("kioskTheme") == "day" else "night"
    return settings


def public_state(state: dict[str, Any] | None = None, scope: str | None = None) -> dict[str, Any]:
    if state is None:
        with _lock:
            state = _load_unlocked()
            if prepare_state(state):
                _save_unlocked(state)
            return _public_view(state, scope)
    prepare_state(state)
    return _public_view(state, scope)


def _public_view(state: dict[str, Any], scope: str | None = None) -> dict[str, Any]:
    lists = state.get("lists") or {}
    today = today_key()
    chores = []
    for chore in state.get("chores") or []:
        row = dict(chore)
        row["dueToday"] = chore_due_on(chore, today)
        row["dueTime"] = chore_due_time(chore)
        if row.get("lateStars") in (None, ""):
            row.pop("lateStars", None)
        chores.append(row)
    view = {
        "version": state.get("version", 1),
        "revision": get_revision(state),
        "kids": state.get("kids", []),
        "chores": chores,
        "consequences": state.get("consequences", []),
        "consequenceHits": recent_consequence_hits(state),
        "bonusHits": recent_bonus_hits(state),
        "starLog": (state.get("starLog") or [])[-1000:],
        "balances": state.get("balances", {}),
        "completions": state.get("completions", {}).get(today, {}),
        "lists": lists,
        "rewards": state.get("rewards", []),
        "redemptions": recent_redemptions(state),
        "whiteboard": state.get("whiteboard") or {"version": 1, "strokes": [], "updatedAt": 0},
        "settings": merged_settings(state),
        "screensaverPhotos": state.get("screensaverPhotos") or [],
        "today": today,
    }
    if scope == "chores":
        for key in (
            "starLog",
            "whiteboard",
            "screensaverPhotos",
            "rewards",
            "redemptions",
            "lists",
        ):
            view.pop(key, None)
    elif scope == "rewards":
        for key in (
            "whiteboard",
            "screensaverPhotos",
            "chores",
            "consequences",
            "consequenceHits",
            "bonusHits",
            "completions",
            "lists",
        ):
            view.pop(key, None)
    elif scope == "calendar":
        for key in (
            "starLog",
            "whiteboard",
            "screensaverPhotos",
            "chores",
            "consequences",
            "consequenceHits",
            "bonusHits",
            "completions",
            "rewards",
            "redemptions",
        ):
            view.pop(key, None)
    return view
