"""Connect the kiosk to the Google Calendar API so event colors come through.

The secret iCal link never includes event colors; only the Calendar API does. This script signs
you in to Google once, gets a long-lived refresh token with read-only calendar access, checks it
can read your family calendar, and saves it to shared/secrets.local.js.

Run on a PC with a browser:   py -3 scripts/google_calendar_auth.py
Optional (new OAuth client):  py -3 scripts/google_calendar_auth.py --client-id ID --client-secret SECRET

Google Cloud requirements (console.cloud.google.com, same project as the client ID):
  * "Google Calendar API" enabled (APIs & Services -> Library).
  * The OAuth client type is "Desktop app" (loopback sign-in). A "Web application" client fails
    with redirect_uri_mismatch -- create a Desktop client and pass it with --client-id/--client-secret.
  * If the consent screen is in "Testing", add your Google account under Test users.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import secrets
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SECRETS = ROOT / "shared" / "secrets.local.js"
CONFIG = ROOT / "shared" / "config.js"
SCOPE = "https://www.googleapis.com/auth/calendar.readonly"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
CAL_API = "https://www.googleapis.com/calendar/v3"


def read_secret(text: str, key: str) -> str:
    m = re.search(rf'{key}:\s*"([^"]*)"', text)
    return m.group(1).strip() if m else ""


def write_secret(text: str, key: str, value: str) -> str:
    pattern = re.compile(rf'({key}:\s*)"[^"]*"')
    if pattern.search(text):
        return pattern.sub(lambda m: f'{m.group(1)}"{value}"', text, count=1)
    idx = text.rfind("};")
    if idx < 0:
        raise SystemExit("Could not find the end of window.FAMILY_SECRETS in secrets.local.js")
    return text[:idx] + f'  {key}: "{value}",\n' + text[idx:]


def http_json(url: str, *, data: dict | None = None, token: str = "") -> dict:
    headers = {"Accept": "application/json"}
    body = None
    if data is not None:
        body = urllib.parse.urlencode(data).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=body, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {detail[:400]}") from exc


def wait_for_code(port_holder: dict, expected_state: str) -> dict:
    result: dict = {}
    done = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if "code" not in query and "error" not in query:
                self.send_response(404)
                self.end_headers()
                return
            if query.get("state", [""])[0] != expected_state:
                result["error"] = "state mismatch"
            elif "error" in query:
                result["error"] = query["error"][0]
            else:
                result["code"] = query["code"][0]
            ok = "code" in result
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            msg = "Google Calendar connected. You can close this tab and return to the terminal." if ok else f"Sign-in failed: {result.get('error')}"
            self.wfile.write(f"<html><body style='font:20px sans-serif;padding:40px'>{msg}</body></html>".encode("utf-8"))
            done.set()

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    port_holder["port"] = server.server_address[1]
    port_holder["ready"].set()
    while not done.is_set():
        server.handle_request()
    server.server_close()
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--client-id", default="")
    parser.add_argument("--client-secret", default="")
    args = parser.parse_args()

    if not SECRETS.exists():
        raise SystemExit("shared/secrets.local.js not found (copy shared/secrets.example.js first)")
    text = SECRETS.read_text(encoding="utf-8")
    client_id = args.client_id or read_secret(text, "googleClientId")
    client_secret = args.client_secret or read_secret(text, "googleClientSecret")
    if not client_id or not client_secret or "YOUR" in client_id:
        raise SystemExit("Need a Google OAuth client: pass --client-id and --client-secret (Desktop app type).")

    cfg_text = CONFIG.read_text(encoding="utf-8") if CONFIG.exists() else ""
    m = re.search(r'calendarId:\s*"([^"]+)"', cfg_text)
    calendar_id = m.group(1).strip() if m else ""
    if not calendar_id:
        raise SystemExit("googleCalendar.calendarId is missing in shared/config.js")

    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)

    holder: dict = {"ready": threading.Event()}
    outcome: dict = {}
    thread = threading.Thread(target=lambda: outcome.update(wait_for_code(holder, state)), daemon=True)
    thread.start()
    holder["ready"].wait()
    redirect_uri = f"http://127.0.0.1:{holder['port']}/"

    url = AUTH_URL + "?" + urllib.parse.urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": SCOPE,
            "access_type": "offline",
            "prompt": "consent",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
        }
    )
    print("Opening Google sign-in in your browser. If it does not open, paste this URL:\n")
    print(url + "\n")
    print("Sign in with the Google account that owns/sees the family calendar and allow read-only calendar access.")
    print("(If Google shows 'redirect_uri_mismatch', the OAuth client is not a Desktop app — see the notes at the top of this script.)\n")
    webbrowser.open(url)
    thread.join()

    if "code" not in outcome:
        raise SystemExit(f"Sign-in did not complete: {outcome.get('error')}")

    tokens = http_json(
        TOKEN_URL,
        data={
            "code": outcome["code"],
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
            "code_verifier": verifier,
        },
    )
    refresh = tokens.get("refresh_token") or ""
    access = tokens.get("access_token") or ""
    if not refresh:
        raise SystemExit("Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and run again.")

    print("Checking access to the family calendar…")
    try:
        cal = http_json(f"{CAL_API}/calendars/{urllib.parse.quote(calendar_id, safe='')}", token=access)
        now = datetime.now(timezone.utc)
        events = http_json(
            f"{CAL_API}/calendars/{urllib.parse.quote(calendar_id, safe='')}/events?"
            + urllib.parse.urlencode(
                {
                    "timeMin": now.isoformat().replace("+00:00", "Z"),
                    "timeMax": (now + timedelta(days=21)).isoformat().replace("+00:00", "Z"),
                    "singleEvents": "true",
                    "maxResults": "250",
                }
            ),
            token=access,
        )
    except RuntimeError as exc:
        msg = str(exc)
        if "accessNotConfigured" in msg or "has not been used" in msg or "disabled" in msg:
            raise SystemExit("The Google Calendar API is not enabled for this OAuth project. Enable it in Google Cloud → APIs & Services → Library, then run again.")
        if "404" in msg:
            raise SystemExit("This Google account cannot see the family calendar. Sign in with an account the calendar is shared with.")
        raise
    items = events.get("items") or []
    color_ids = sorted({str(i.get("colorId")) for i in items if i.get("colorId")})
    print(f"  Calendar: {cal.get('summary')}  (calendar color {cal.get('backgroundColor')})")
    print(f"  {len(items)} events in the next 3 weeks; custom event colors in use: {', '.join(color_ids) or 'none'}")

    text = write_secret(text, "googleRefreshToken", refresh)
    if args.client_id:
        text = write_secret(text, "googleClientId", client_id)
    if args.client_secret:
        text = write_secret(text, "googleClientSecret", client_secret)
    SECRETS.write_text(text, encoding="utf-8")
    print("\nSaved to shared/secrets.local.js on this PC.")
    print("\nNow put the same values on the Pi: Admin → More → Setup → family-board-src (unlock) → Secrets,")
    print("set these lines, and Save:")
    if args.client_id:
        print(f'  googleClientId: "{client_id}",')
    if args.client_secret:
        print(f'  googleClientSecret: "{client_secret}",')
    print(f'  googleRefreshToken: "{refresh}",')
    print("\nThe kiosk picks it up on its next calendar refresh (about a minute).")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(1)
