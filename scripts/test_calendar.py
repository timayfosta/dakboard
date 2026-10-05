"""Calendar correctness checks — run before every deploy:  py -3 scripts/test_calendar.py

1. Synthetic feed: every tricky case that can put an event on the wrong day or time.
2. Real feed (data/calendar-cache.ics, if present): every one-off event must land on exactly
   the date/instant Google wrote in the feed.
Exits non-zero on any failure.
"""

from __future__ import annotations

import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "shared"))

import ical  # noqa: E402

UTC = timezone.utc
FAILURES: list[str] = []


def chicago(utc_text: str) -> datetime:
    """UTC 'Z' string -> naive Chicago wall clock (US rules, 2026)."""
    dt = datetime.strptime(utc_text, "%Y-%m-%dT%H:%M:%SZ")
    dst_start = datetime(2026, 3, 8, 8)  # 2am CST = 08:00Z
    dst_end = datetime(2026, 11, 1, 7)  # 2am CDT = 07:00Z
    return dt - timedelta(hours=5 if dst_start <= dt < dst_end else 6)


def check(label: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        FAILURES.append(label)


VTZ = """BEGIN:VTIMEZONE
TZID:America/Chicago
X-LIC-LOCATION:America/Chicago
BEGIN:DAYLIGHT
TZOFFSETFROM:-0600
TZOFFSETTO:-0500
TZNAME:CDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0500
TZOFFSETTO:-0600
TZNAME:CST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE"""

FEED = f"""BEGIN:VCALENDAR
VERSION:2.0
X-WR-TIMEZONE:UTC
{VTZ}
BEGIN:VEVENT
UID:allday-single
DTSTART;VALUE=DATE:20261009
DTEND;VALUE=DATE:20261010
SUMMARY:No school
END:VEVENT
BEGIN:VEVENT
UID:allday-multi
DTSTART;VALUE=DATE:20261007
DTEND;VALUE=DATE:20261009
SUMMARY:Conferences
END:VEVENT
BEGIN:VEVENT
UID:late-utc
DTSTART:20261007T033000Z
DTEND:20261007T043000Z
SUMMARY:Late game
BEGIN:VALARM
ACTION:DISPLAY
SUMMARY:Alarm text must not become the title
TRIGGER:-PT30M
END:VALARM
END:VEVENT
BEGIN:VEVENT
UID:tzid-single
DTSTART;TZID=America/Chicago:20261008T001500
DTEND;TZID=America/Chicago:20261008T010000
SUMMARY:Just after midnight
END:VEVENT
BEGIN:VEVENT
UID:weekly-byday
DTSTART;TZID=America/Chicago:20260901T153000
DTEND;TZID=America/Chicago:20260901T173000
RRULE:FREQ=WEEKLY;WKST=SU;UNTIL=20261023T045959Z;BYDAY=TU,TH
EXDATE;TZID=America/Chicago:20261013T153000
SUMMARY:Practice
END:VEVENT
BEGIN:VEVENT
UID:weekly-byday
RECURRENCE-ID;TZID=America/Chicago:20261015T153000
DTSTART;TZID=America/Chicago:20261016T160000
DTEND;TZID=America/Chicago:20261016T180000
SUMMARY:Practice (moved to Fri)
END:VEVENT
BEGIN:VEVENT
UID:weekly-byday
RECURRENCE-ID;TZID=America/Chicago:20261008T153000
DTSTART;TZID=America/Chicago:20261008T153000
DTEND;TZID=America/Chicago:20261008T173000
STATUS:CANCELLED
SUMMARY:Practice
END:VEVENT
BEGIN:VEVENT
UID:dst-weekly
DTSTART;TZID=America/Chicago:20261021T190000
DTEND;TZID=America/Chicago:20261021T200000
RRULE:FREQ=WEEKLY
SUMMARY:Wednesday night
END:VEVENT
BEGIN:VEVENT
UID:ended-series
DTSTART;TZID=America/Chicago:20250701T090000
DTEND;TZID=America/Chicago:20250701T100000
RRULE:FREQ=WEEKLY;UNTIL=20250930T045959Z
SUMMARY:Old summer thing
END:VEVENT
BEGIN:VEVENT
UID:monthly-nth
DTSTART;TZID=America/Chicago:20260113T183000
DTEND;TZID=America/Chicago:20260113T193000
RRULE:FREQ=MONTHLY;BYDAY=2TU
SUMMARY:Board meeting
END:VEVENT
BEGIN:VEVENT
UID:count-daily
DTSTART;VALUE=DATE:20261004
DTEND;VALUE=DATE:20261005
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:Camp
END:VEVENT
BEGIN:VEVENT
UID:yearly-bday
DTSTART;VALUE=DATE:20200411
DTEND;VALUE=DATE:20200412
RRULE:FREQ=YEARLY;WKST=SU;INTERVAL=1;BYMONTHDAY=11;BYMONTH=10
SUMMARY:Birthday
END:VEVENT
END:VCALENDAR
"""


def by_title(events, title):
    return [e for e in events if e["title"] == title]


def synthetic() -> None:
    print("Synthetic feed")
    now = datetime(2026, 10, 5, 16, 0, tzinfo=UTC)
    events = ical.parse_feed(FEED, tz_name="America/Chicago", days_ahead=40, now=now)

    ns = by_title(events, "No school")
    check("all-day single stays on Fri Oct 9", [e["start"] for e in ns] == ["2026-10-09T00:00:00"], str(ns))
    check("all-day end is same day (inclusive)", ns and ns[0]["end"] == "2026-10-09T23:59:59")

    conf = by_title(events, "Conferences")
    check(
        "multi-day all-day covers Oct 7-8 only",
        conf and conf[0]["start"] == "2026-10-07T00:00:00" and conf[0]["end"] == "2026-10-08T23:59:59",
        str(conf),
    )

    late = by_title(events, "Late game")
    check("UTC event at 03:30Z shows Oct 6 10:30pm Chicago", late and chicago(late[0]["start"]) == datetime(2026, 10, 6, 22, 30), str(late))
    check("VALARM summary ignored", not by_title(events, "Alarm text must not become the title"))

    mid = by_title(events, "Just after midnight")
    check("TZID 12:15am stays on Oct 8", mid and chicago(mid[0]["start"]) == datetime(2026, 10, 8, 0, 15), str(mid))

    practice = sorted(chicago(e["start"]) for e in by_title(events, "Practice"))
    expected = [
        datetime(2026, 10, 6, 15, 30),
        datetime(2026, 10, 20, 15, 30),
        datetime(2026, 10, 22, 15, 30),
    ]
    check("weekly TU/TH honors EXDATE, cancel, move, UNTIL", practice == expected, str(practice))
    moved = by_title(events, "Practice (moved to Fri)")
    check("moved instance on Fri Oct 16 4pm", moved and chicago(moved[0]["start"]) == datetime(2026, 10, 16, 16, 0), str(moved))

    wed = sorted(chicago(e["start"]) for e in by_title(events, "Wednesday night"))
    check(
        "weekly keeps 7pm wall clock across DST end (Nov 1)",
        wed[:3] == [datetime(2026, 10, 21, 19), datetime(2026, 10, 28, 19), datetime(2026, 11, 4, 19)],
        str(wed[:3]),
    )

    check("series that ended in 2025 does not appear", not by_title(events, "Old summer thing"))

    board = [chicago(e["start"]) for e in by_title(events, "Board meeting")]
    check("monthly 2nd Tuesday -> Oct 13 and Nov 10", board == [datetime(2026, 10, 13, 18, 30), datetime(2026, 11, 10, 18, 30)], str(board))

    camp = [e["start"][:10] for e in by_title(events, "Camp")]
    check("COUNT=3 daily from Oct 4 (yesterday kept) -> Oct 4,5,6", camp == ["2026-10-04", "2026-10-05", "2026-10-06"], str(camp))

    bday = [e["start"][:10] for e in by_title(events, "Birthday")]
    check("yearly BYMONTH/BYMONTHDAY -> Oct 11", bday == ["2026-10-11"], str(bday))

    for e in events:
        if e["allDay"]:
            ok = re.fullmatch(r"\d{4}-\d{2}-\d{2}T00:00:00", e["start"]) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T23:59:59", e["end"])
        else:
            ok = e["start"].endswith("Z") and e["end"].endswith("Z")
        if not ok:
            check(f"output format for {e['title']}", False, str(e))
            break
    else:
        check("output format (all-day local dates, timed UTC Z)", True)


def real_feed() -> None:
    path = ROOT / "data" / "calendar-cache.ics"
    if not path.exists():
        print("Real feed: data/calendar-cache.ics not found (skipped)")
        return
    print("Real feed (data/calendar-cache.ics)")
    text = path.read_text(encoding="utf-8", errors="replace")
    now = datetime.now(UTC)
    events = ical.parse_feed(text, tz_name="America/Chicago", days_ahead=21, now=now)
    by_id = {}
    for e in events:
        by_id.setdefault(e["id"], []).append(e)

    root = ical.parse_components(text)
    checked = 0
    today = now.astimezone(ical.household_tz("America/Chicago")).date() if ical.ZoneInfo else now.date()
    for ev in ical.walk(root, "VEVENT"):
        if ev.get("RRULE") or ev.get("RECURRENCE-ID"):
            continue
        status = ev.get("STATUS")
        if status and status.value.strip().upper() == "CANCELLED":
            continue
        uid = ev.get("UID").value.strip() if ev.get("UID") else ""
        start = ev.get("DTSTART")
        if not uid or not start:
            continue
        raw = start.value.strip()
        title = ev.get("SUMMARY").value if ev.get("SUMMARY") else "(No title)"
        if re.fullmatch(r"\d{8}", raw):
            d = datetime.strptime(raw, "%Y%m%d").date()
            if not (today <= d <= today + timedelta(days=20)):
                continue
            got = [e["start"] for e in by_id.get(uid, [])]
            check(f"{d} all-day '{title[:30]}'", got == [f"{d.isoformat()}T00:00:00"], str(got))
            checked += 1
        elif raw.endswith("Z"):
            dt = datetime.strptime(raw, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
            if not (now <= dt <= now + timedelta(days=20)):
                continue
            got = [e["start"] for e in by_id.get(uid, [])]
            check(f"{dt:%Y-%m-%d %H:%MZ} '{title[:30]}'", got == [dt.strftime("%Y-%m-%dT%H:%M:%SZ")], str(got))
            checked += 1
    print(f"  checked {checked} one-off events against the raw feed")


if __name__ == "__main__":
    synthetic()
    real_feed()
    if FAILURES:
        print(f"\n{len(FAILURES)} calendar check(s) FAILED")
        sys.exit(1)
    print("\nAll calendar checks passed")
