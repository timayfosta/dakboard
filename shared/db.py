"""Family Board JSON database (local now → Cloudflare later)."""

from __future__ import annotations

import json
import threading
import time
import uuid
from copy import deepcopy
from datetime import date
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "family.json"
_lock = threading.Lock()


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
                    "repeat": "daily",
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


def load_db() -> dict[str, Any]:
    with _lock:
        DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
        if not DATA_PATH.exists():
            state = default_state()
            DATA_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")
            return deepcopy(state)
        try:
            raw = DATA_PATH.read_text(encoding="utf-8")
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError("family.json root must be an object")
            return data
        except (json.JSONDecodeError, ValueError, OSError) as exc:
            # Keep a backup and reseeds so the server can still boot on Pi
            backup = DATA_PATH.with_suffix(f".bad-{int(time.time())}.json")
            try:
                DATA_PATH.replace(backup)
            except OSError:
                backup = None
            state = default_state()
            DATA_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")
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


def get_revision(state: dict[str, Any] | None = None) -> int:
    state = state or load_db()
    return int((state.get("meta") or {}).get("revision") or 0)


def save_db(state: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        bump_revision(state)
        DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = DATA_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
        tmp.replace(DATA_PATH)
        return deepcopy(state)


CHORE_PERIOD_DEADLINE = {
    "morning": (12, 0),
    "afternoon": (17, 0),
    "evening": (21, 0),
}


def chore_stars_for_now(chore: dict[str, Any], when=None) -> tuple[int, bool]:
    from datetime import datetime

    base = int(chore.get("stars") or 1)
    period = chore.get("period") or "chore"
    deadline = CHORE_PERIOD_DEADLINE.get(period)
    if not deadline:
        return base, False
    now = when or datetime.now()
    now_mins = now.hour * 60 + now.minute
    dead_mins = deadline[0] * 60 + deadline[1]
    if now_mins > dead_mins:
        return max(1, base // 2), True
    return base, False


def completion_stars(entry: Any, chore: dict[str, Any]) -> int:
    if entry is True:
        return int(chore.get("stars") or 1)
    if isinstance(entry, dict):
        return int(entry.get("stars") or chore.get("stars") or 1)
    if isinstance(entry, (int, float)):
        return int(entry)
    return 0


def today_key() -> str:
    return date.today().isoformat()


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
    return settings


def public_state(state: dict[str, Any] | None = None) -> dict[str, Any]:
    state = state or load_db()
    lists = state.get("lists") or {}
    return {
        "version": state.get("version", 1),
        "revision": get_revision(state),
        "kids": state.get("kids", []),
        "chores": state.get("chores", []),
        "balances": state.get("balances", {}),
        "completions": state.get("completions", {}).get(today_key(), {}),
        "lists": lists,
        "rewards": state.get("rewards", []),
        "redemptions": state.get("redemptions", [])[:20],
        "whiteboard": state.get("whiteboard") or {"version": 1, "strokes": [], "updatedAt": 0},
        "settings": merged_settings(state),
        "screensaverPhotos": state.get("screensaverPhotos") or [],
        "today": today_key(),
    }
