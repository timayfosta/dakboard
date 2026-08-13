"""Resolve photo album links (Google Photos, iCloud, direct URLs) for the screensaver."""

from __future__ import annotations

import hashlib
import re
import time
import urllib.parse
import urllib.request
from typing import Any

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
CACHE_TTL = 900  # 15 minutes
PORTRAIT_W = 1080
PORTRAIT_H = 1920

BUILTIN_ALBUMS: dict[str, dict[str, str]] = {
    "nature": {
        "label": "Nature",
        "type": "builtin",
    },
}

# Portrait-oriented nature photos (1080×1920 crop via Unsplash CDN)
NATURE_FALLBACK_URLS = [
    "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?auto=format&fit=crop&w=1080&h=1920&q=85",
    "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=1080&h=1920&q=85",
    "https://images.unsplash.com/photo-1470071459604-3b5ec3a8fe89?auto=format&fit=crop&w=1080&h=1920&q=85",
    "https://images.unsplash.com/photo-1518173945613-d6efba1672ee?auto=format&fit=crop&w=1080&h=1920&q=85",
    "https://images.unsplash.com/photo-1469474968028-56623f02e42e?auto=format&fit=crop&w=1080&h=1920&q=85",
    "https://images.unsplash.com/photo-1439066615861-d1af74d74000?auto=format&fit=crop&w=1080&h=1920&q=85",
    "https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&w=1080&h=1920&q=85",
    "https://images.unsplash.com/photo-1475924156734-496f6cac6ec1?auto=format&fit=crop&w=1080&h=1920&q=85",
    "https://images.unsplash.com/photo-1418065460487-3e41a274cc55?auto=format&fit=crop&w=1080&h=1920&q=85",
    "https://images.unsplash.com/photo-1454496521458-7a8e268e7861?auto=format&fit=crop&w=1080&h=1920&q=85",
    "https://images.unsplash.com/photo-1483728642387-6c3bdd6c93e5?auto=format&fit=crop&w=1080&h=1920&q=85",
    "https://images.unsplash.com/photo-1501854140801-50d01698950b?auto=format&fit=crop&w=1080&h=1920&q=85",
    "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=1080&h=1920&q=85",
    "https://images.unsplash.com/photo-1493246507139-91e639af3600?auto=format&fit=crop&w=1080&h=1920&q=85",
    "https://images.unsplash.com/photo-1523712999610-f77fbcfc3844?auto=format&fit=crop&w=1080&h=1920&q=85",
    "https://images.unsplash.com/photo-1518495973542-4542c06a5843?auto=format&fit=crop&w=1080&h=1920&q=85",
    "https://images.unsplash.com/photo-1472214103451-9374bd1c798e?auto=format&fit=crop&w=1080&h=1920&q=85",
    "https://images.unsplash.com/photo-1501785888041-af3ef285b470?auto=format&fit=crop&w=1080&h=1920&q=85",
    "https://images.unsplash.com/photo-1447752875215-b9731fbf65b0?auto=format&fit=crop&w=1080&h=1920&q=85",
    "https://images.unsplash.com/photo-1426604966848-d7ad8d695737?auto=format&fit=crop&w=1080&h=1920&q=85",
]

_cache: dict[str, tuple[float, list[str]]] = {}
_photo_registry: dict[str, str] = {}


def stable_photo_id(remote_url: str) -> str:
    digest = hashlib.sha256(remote_url.encode("utf-8")).hexdigest()[:20]
    return f"p_{digest}"


def register_photo(remote_url: str) -> str:
    photo_id = stable_photo_id(remote_url)
    _photo_registry[photo_id] = remote_url
    return photo_id


def lookup_photo(photo_id: str) -> str | None:
    return _photo_registry.get(photo_id)


def photo_proxy_url(photo_id: str) -> str:
    return f"/api/screensaver/photo?id={urllib.parse.quote(photo_id, safe='')}"


def fetch_page(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=45) as resp:
        return resp.read().decode("utf-8", errors="ignore")


def normalize_google_url(url: str) -> str:
    url = url.rstrip("\\").split("\\u")[0]
    base = re.sub(r"=w\d+(-h\d+)?(-no)?.*$", "", url)
    base = re.sub(r"=s\d+.*$", "", base)
    return f"{base}=w{PORTRAIT_W}-h{PORTRAIT_H}-no"


def extract_google_photos(html: str) -> list[str]:
    found = re.findall(r"https://lh3\.googleusercontent\.com/[^\s\"'\\<>]+", html)
    out: list[str] = []
    seen: set[str] = set()
    for raw in found:
        url = normalize_google_url(raw)
        if url not in seen and "default-user" not in url:
            seen.add(url)
            out.append(url)
    return out


def extract_icloud_photos(html: str) -> list[str]:
    patterns = [
        r"https://cv\d+\.icloud\.com/[^\s\"'\\<>]+",
        r"https://ck\d+\.icloud\.com/[^\s\"'\\<>]+",
    ]
    out: list[str] = []
    seen: set[str] = set()
    for pattern in patterns:
        for raw in re.findall(pattern, html, flags=re.I):
            url = raw.rstrip("\\").split("\\u")[0]
            if url not in seen:
                seen.add(url)
                out.append(url)
    return out


def resolve_album_url(source_type: str, url: str) -> list[str]:
    text = (url or "").strip()
    if not text:
        return []

    if source_type == "urls":
        return resolve_direct_urls(text)

    cache_key = f"{source_type}:{text}"
    cached = _cache.get(cache_key)
    if cached and time.time() - cached[0] < CACHE_TTL:
        return cached[1]

    photos: list[str] = []
    try:
        if source_type == "google":
            photos = extract_google_photos(fetch_page(text))
        elif source_type == "icloud":
            photos = extract_icloud_photos(fetch_page(text))
        else:
            photos = resolve_direct_urls(text)
    except Exception:
        photos = []

    _cache[cache_key] = (time.time(), photos)
    return photos


def resolve_direct_urls(text: str) -> list[str]:
    parts = re.split(r"[\n,]+", text)
    out: list[str] = []
    seen: set[str] = set()
    for part in parts:
        url = part.strip()
        if url.startswith("http") and url not in seen:
            seen.add(url)
            out.append(url)
    return out


def resolve_builtin(album_id: str) -> list[str]:
    if album_id not in BUILTIN_ALBUMS:
        return []
    cache_key = f"builtin:{album_id}"
    cached = _cache.get(cache_key)
    if cached and time.time() - cached[0] < CACHE_TTL:
        return cached[1]
    photos = list(NATURE_FALLBACK_URLS) if album_id == "nature" else []
    _cache[cache_key] = (time.time(), photos)
    return photos


def active_album_ids(settings: dict[str, Any]) -> set[str] | None:
    """Return selected album ids from saved settings, or None = show all (legacy)."""
    ss = settings.get("screensaver") or {}
    if "activeAlbumIds" not in ss:
        return None
    return set(ss.get("activeAlbumIds") or [])


def album_is_active(album_id: str, active: set[str] | None) -> bool:
    if active is None:
        return True
    return album_id in active


def build_photo_manifest(state: dict[str, Any]) -> list[dict[str, str]]:
    raw_settings = state.get("settings") or {}
    ss = raw_settings.get("screensaver") or {}
    active = active_album_ids(raw_settings)
    photos: list[dict[str, str]] = []

    if album_is_active("nature", active):
        label = BUILTIN_ALBUMS["nature"]["label"]
        for remote in resolve_builtin("nature"):
            photo_id = register_photo(remote)
            photos.append({"id": photo_id, "url": photo_proxy_url(photo_id), "label": label})

    for source in ss.get("sources") or []:
        source_id = str(source.get("id") or "")
        if not source_id or not album_is_active(source_id, active):
            continue
        src_type = str(source.get("type") or "urls")
        label = str(source.get("label") or "Album")
        for remote in resolve_album_url(src_type, str(source.get("url") or "")):
            photo_id = register_photo(remote)
            photos.append({"id": photo_id, "url": photo_proxy_url(photo_id), "label": label})

    if album_is_active("uploads", active):
        for item in state.get("screensaverPhotos") or []:
            photo_id = str(item.get("id") or "")
            if not photo_id:
                continue
            photos.append(
                {
                    "id": photo_id,
                    "url": f"/api/screensaver/photo?local={urllib.parse.quote(photo_id, safe='')}",
                    "label": str(item.get("label") or "Upload"),
                }
            )

    return photos
