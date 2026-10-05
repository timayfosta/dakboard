"""iCalendar (Google secret iCal feed) -> flat event list for the kiosk.

Output contract (what the browser relies on to put events on the right day):
  * All-day events:  start "YYYY-MM-DDT00:00:00", end "YYYY-MM-DDT23:59:59" of the LAST day
    (inclusive, no timezone suffix). Browsers read these as local wall-clock dates, so the day
    never shifts no matter what timezone the display is in.
  * Timed events:    absolute UTC instants, "YYYY-MM-DDTHH:MM:SSZ".

Recurring events are expanded in the event's own timezone (TZID), so DST changes keep the
wall-clock time. Moved instances (RECURRENCE-ID), deleted instances (EXDATE), cancelled
events and series end dates (UNTIL / COUNT) are honored.

Stdlib only. Uses zoneinfo when the OS has tz data (Raspberry Pi OS does); otherwise falls
back to the VTIMEZONE definitions embedded in the feed itself.
"""

from __future__ import annotations

import calendar as _cal
import re
from datetime import date, datetime, time, timedelta, timezone, tzinfo
from typing import Any

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None  # type: ignore[assignment]

UTC = timezone.utc
WEEKDAYS = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}
MAX_INSTANCES = 2000
MAX_PERIODS = 20000

# Outlook / Exchange invites sometimes carry Windows zone names.
WINDOWS_TZ = {
    "Central Standard Time": "America/Chicago",
    "Eastern Standard Time": "America/New_York",
    "Mountain Standard Time": "America/Denver",
    "US Mountain Standard Time": "America/Phoenix",
    "Pacific Standard Time": "America/Los_Angeles",
    "Alaskan Standard Time": "America/Anchorage",
    "Hawaiian Standard Time": "Pacific/Honolulu",
    "UTC": "UTC",
    "GMT Standard Time": "Europe/London",
}


# --------------------------------------------------------------------------- parsing


class Prop:
    __slots__ = ("name", "params", "value")

    def __init__(self, name: str, params: dict[str, str], value: str):
        self.name = name
        self.params = params
        self.value = value


class Component:
    def __init__(self, kind: str):
        self.kind = kind
        self.props: list[Prop] = []
        self.children: list[Component] = []

    def get(self, name: str) -> Prop | None:
        for prop in self.props:
            if prop.name == name:
                return prop
        return None

    def get_all(self, name: str) -> list[Prop]:
        return [prop for prop in self.props if prop.name == name]


def _split_params(head: str) -> tuple[str, dict[str, str]]:
    parts: list[str] = []
    buf = ""
    quoted = False
    for ch in head:
        if ch == '"':
            quoted = not quoted
            continue
        if ch == ";" and not quoted:
            parts.append(buf)
            buf = ""
            continue
        buf += ch
    parts.append(buf)
    name = parts[0].strip().upper()
    params: dict[str, str] = {}
    for item in parts[1:]:
        if "=" in item:
            key, val = item.split("=", 1)
            params[key.strip().upper()] = val.strip()
    return name, params


def _split_line(line: str) -> tuple[str, str]:
    quoted = False
    for i, ch in enumerate(line):
        if ch == '"':
            quoted = not quoted
        elif ch == ":" and not quoted:
            return line[:i], line[i + 1 :]
    return line, ""


def parse_components(text: str) -> Component:
    text = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\n[ \t]", "", text)
    root = Component("ROOT")
    stack = [root]
    for raw in text.split("\n"):
        if not raw.strip():
            continue
        head, value = _split_line(raw)
        name, params = _split_params(head)
        if name == "BEGIN":
            comp = Component(value.strip().upper())
            stack[-1].children.append(comp)
            stack.append(comp)
        elif name == "END":
            if len(stack) > 1:
                stack.pop()
        else:
            stack[-1].props.append(Prop(name, params, value))
    return root


def walk(comp: Component, kind: str) -> list[Component]:
    out: list[Component] = []
    for child in comp.children:
        if child.kind == kind:
            out.append(child)
        out.extend(walk(child, kind))
    return out


def unescape_text(value: str) -> str:
    out = []
    i = 0
    while i < len(value):
        ch = value[i]
        if ch == "\\" and i + 1 < len(value):
            nxt = value[i + 1]
            out.append("\n" if nxt in "nN" else nxt)
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


# --------------------------------------------------------------------------- timezones


def _parse_offset(value: str) -> timedelta:
    m = re.fullmatch(r"([+-])(\d{2})(\d{2})(\d{2})?", value.strip())
    if not m:
        return timedelta(0)
    sign = -1 if m.group(1) == "-" else 1
    return sign * timedelta(hours=int(m.group(2)), minutes=int(m.group(3)), seconds=int(m.group(4) or 0))


class VTimezone(tzinfo):
    """tzinfo built from a feed's VTIMEZONE block (used only when the OS lacks tz data)."""

    def __init__(self, tzid: str, comp: Component):
        self.tzid = tzid
        self.rules: list[dict[str, Any]] = []
        for sub in comp.children:
            if sub.kind not in ("STANDARD", "DAYLIGHT"):
                continue
            start = sub.get("DTSTART")
            if not start:
                continue
            try:
                local = datetime.strptime(start.value.strip()[:15], "%Y%m%dT%H%M%S")
            except ValueError:
                continue
            rrule_prop = sub.get("RRULE")
            self.rules.append(
                {
                    "start": local,
                    "from": _parse_offset((sub.get("TZOFFSETFROM") or Prop("", {}, "+0000")).value),
                    "to": _parse_offset((sub.get("TZOFFSETTO") or Prop("", {}, "+0000")).value),
                    "rrule": parse_rrule(rrule_prop.value) if rrule_prop else None,
                    "rdates": [
                        datetime.strptime(v.strip()[:15], "%Y%m%dT%H%M%S")
                        for p in sub.get_all("RDATE")
                        for v in p.value.split(",")
                        if re.match(r"\d{8}T\d{6}", v.strip())
                    ],
                    "dst": sub.kind == "DAYLIGHT",
                    "name": (sub.get("TZNAME") or Prop("", {}, tzid)).value,
                }
            )
        self._cache: dict[int, list[tuple[datetime, dict[str, Any]]]] = {}

    def _transitions(self, year: int) -> list[tuple[datetime, dict[str, Any]]]:
        if year in self._cache:
            return self._cache[year]
        out: list[tuple[datetime, dict[str, Any]]] = []
        for rule in self.rules:
            start: datetime = rule["start"]
            if start.year == year:
                out.append((start, rule))
            for rd in rule["rdates"]:
                if rd.year == year:
                    out.append((rd, rule))
            rr = rule["rrule"]
            if not rr or year <= start.year:
                continue
            until = rr.get("UNTIL")
            months = [int(m) for m in rr.get("BYMONTH", str(start.month)).split(",") if m]
            for month in months:
                days = _month_byday_days(year, month, rr.get("BYDAY", "")) if rr.get("BYDAY") else [start.day]
                for day in days:
                    try:
                        when = datetime(year, month, day, start.hour, start.minute, start.second)
                    except ValueError:
                        continue
                    if until and re.match(r"\d{8}", until):
                        if when.date() > datetime.strptime(until[:8], "%Y%m%d").date():
                            continue
                    out.append((when, rule))
        out.sort(key=lambda row: row[0])
        self._cache[year] = out
        return out

    def _rule_for_local(self, dt: datetime) -> dict[str, Any] | None:
        naive = dt.replace(tzinfo=None)
        best = None
        for year in (naive.year - 1, naive.year):
            for when, rule in self._transitions(year):
                if when <= naive:
                    best = rule
        if best is None and self.rules:
            first = min(self.rules, key=lambda r: r["start"])
            return {"to": first["from"], "dst": False, "name": self.tzid}
        return best

    def utcoffset(self, dt: datetime | None) -> timedelta:
        if dt is None or not self.rules:
            return timedelta(0)
        rule = self._rule_for_local(dt)
        return rule["to"] if rule else timedelta(0)

    def dst(self, dt: datetime | None) -> timedelta:
        return timedelta(0)

    def tzname(self, dt: datetime | None) -> str:
        if dt is None:
            return self.tzid
        rule = self._rule_for_local(dt)
        return str(rule["name"]) if rule else self.tzid

    def fromutc(self, dt: datetime) -> datetime:
        naive = dt.replace(tzinfo=None)
        offset = None
        for year in (naive.year - 1, naive.year, naive.year + 1):
            for when, rule in self._transitions(year):
                if when - rule["from"] <= naive:
                    offset = rule["to"]
        if offset is None:
            offset = self.utcoffset(naive)
        return (naive + offset).replace(tzinfo=self)


def resolve_tz(tzid: str, vtimezones: dict[str, tzinfo], default: tzinfo) -> tzinfo:
    tzid = (tzid or "").strip().strip('"')
    if not tzid:
        return default
    if tzid.upper() in ("UTC", "Z", "GMT", "ETC/UTC"):
        return UTC
    for candidate in (tzid, WINDOWS_TZ.get(tzid, ""), tzid.lstrip("/").split("/", 1)[-1] if tzid.startswith("/") else ""):
        if candidate and ZoneInfo is not None:
            try:
                return ZoneInfo(candidate)
            except Exception:  # noqa: BLE001
                pass
    if tzid in vtimezones:
        return vtimezones[tzid]
    return default


def household_tz(tz_name: str, vtimezones: dict[str, tzinfo] | None = None) -> tzinfo:
    vtz = vtimezones or {}
    if ZoneInfo is not None and tz_name:
        try:
            return ZoneInfo(tz_name)
        except Exception:  # noqa: BLE001
            pass
    if tz_name and tz_name in vtz:
        return vtz[tz_name]
    local = datetime.now().astimezone().tzinfo
    return local or UTC


# --------------------------------------------------------------------------- date values


def parse_value(prop: Prop | None, vtimezones: dict[str, tzinfo], default_tz: tzinfo) -> tuple[Any, bool]:
    """Returns (value, all_day). value is a date for all-day, aware datetime otherwise."""
    if prop is None:
        return None, False
    return parse_raw(prop.value, prop.params, vtimezones, default_tz)


def parse_raw(raw: str, params: dict[str, str], vtimezones: dict[str, tzinfo], default_tz: tzinfo) -> tuple[Any, bool]:
    raw = (raw or "").strip()
    if params.get("VALUE", "").upper() == "DATE" or re.fullmatch(r"\d{8}", raw):
        try:
            return datetime.strptime(raw[:8], "%Y%m%d").date(), True
        except ValueError:
            return None, True
    m = re.fullmatch(r"(\d{8})T(\d{6})(Z?)", raw)
    if not m:
        return None, False
    naive = datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S")
    if m.group(3) == "Z":
        return naive.replace(tzinfo=UTC), False
    tz = resolve_tz(params.get("TZID", ""), vtimezones, default_tz)
    return naive.replace(tzinfo=tz), False


def parse_duration(value: str) -> timedelta | None:
    m = re.fullmatch(
        r"([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?",
        (value or "").strip().upper(),
    )
    if not m:
        return None
    sign = -1 if m.group(1) == "-" else 1
    weeks, days, hours, minutes, seconds = (int(g or 0) for g in m.groups()[1:])
    return sign * timedelta(weeks=weeks, days=days, hours=hours, minutes=minutes, seconds=seconds)


# --------------------------------------------------------------------------- recurrence


def parse_rrule(value: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in (value or "").replace("RRULE:", "").split(";"):
        if "=" in part:
            key, val = part.split("=", 1)
            out[key.strip().upper()] = val.strip()
    return out


def _byday_tokens(spec: str) -> list[tuple[int | None, int]]:
    out: list[tuple[int | None, int]] = []
    for token in (spec or "").split(","):
        m = re.fullmatch(r"([+-]?\d{1,2})?([A-Z]{2})", token.strip().upper())
        if m and m.group(2) in WEEKDAYS:
            out.append((int(m.group(1)) if m.group(1) else None, WEEKDAYS[m.group(2)]))
    return out


def _month_byday_days(year: int, month: int, spec: str) -> list[int]:
    ndays = _cal.monthrange(year, month)[1]
    days: set[int] = set()
    for nth, wd in _byday_tokens(spec):
        matches = [d for d in range(1, ndays + 1) if date(year, month, d).weekday() == wd]
        if nth is None:
            days.update(matches)
        elif 0 < nth <= len(matches):
            days.add(matches[nth - 1])
        elif nth < 0 and -nth <= len(matches):
            days.add(matches[nth])
    return sorted(days)


def _month_days(year: int, month: int, rule: dict[str, str], anchor: date) -> list[int]:
    ndays = _cal.monthrange(year, month)[1]
    monthdays: list[int] | None = None
    if rule.get("BYMONTHDAY"):
        monthdays = []
        for tok in rule["BYMONTHDAY"].split(","):
            try:
                n = int(tok)
            except ValueError:
                continue
            day = n if n > 0 else ndays + n + 1
            if 1 <= day <= ndays:
                monthdays.append(day)
    bydays = _month_byday_days(year, month, rule["BYDAY"]) if rule.get("BYDAY") else None
    if monthdays is not None and bydays is not None:
        return sorted(set(monthdays) & set(bydays))
    if monthdays is not None:
        return sorted(set(monthdays))
    if bydays is not None:
        return bydays
    return [anchor.day] if anchor.day <= ndays else []


def _apply_setpos(days: list[date], rule: dict[str, str]) -> list[date]:
    if not rule.get("BYSETPOS") or not days:
        return days
    picked: list[date] = []
    for tok in rule["BYSETPOS"].split(","):
        try:
            n = int(tok)
        except ValueError:
            continue
        if 0 < n <= len(days):
            picked.append(days[n - 1])
        elif n < 0 and -n <= len(days):
            picked.append(days[n])
    return sorted(set(picked))


def _period_days(freq: str, period_start: date, rule: dict[str, str], anchor: date, wkst: int) -> list[date]:
    months = [int(m) for m in rule.get("BYMONTH", "").split(",") if m.strip().isdigit()]
    if freq == "DAILY":
        d = period_start
        ok = (not months or d.month in months)
        if ok and rule.get("BYDAY"):
            ok = d.weekday() in {wd for _, wd in _byday_tokens(rule["BYDAY"])}
        if ok and rule.get("BYMONTHDAY"):
            ok = d.day in _month_days(d.year, d.month, {"BYMONTHDAY": rule["BYMONTHDAY"]}, anchor)
        return [d] if ok else []
    if freq == "WEEKLY":
        weekdays = {wd for _, wd in _byday_tokens(rule.get("BYDAY", ""))} or {anchor.weekday()}
        days = [period_start + timedelta(days=i) for i in range(7)]
        days = [d for d in days if d.weekday() in weekdays and (not months or d.month in months)]
        return _apply_setpos(days, rule)
    if freq == "MONTHLY":
        if months and period_start.month not in months:
            return []
        days = [date(period_start.year, period_start.month, d) for d in _month_days(period_start.year, period_start.month, rule, anchor)]
        return _apply_setpos(days, rule)
    if freq == "YEARLY":
        year = period_start.year
        out: list[date] = []
        if months:
            for month in months:
                if rule.get("BYMONTHDAY") or rule.get("BYDAY"):
                    sub = rule
                else:
                    sub = {"BYMONTHDAY": str(anchor.day)}
                out.extend(date(year, month, d) for d in _month_days(year, month, sub, anchor))
        elif rule.get("BYYEARDAY"):
            ylen = 366 if _cal.isleap(year) else 365
            for tok in rule["BYYEARDAY"].split(","):
                try:
                    n = int(tok)
                except ValueError:
                    continue
                idx = n if n > 0 else ylen + n + 1
                if 1 <= idx <= ylen:
                    out.append(date(year, 1, 1) + timedelta(days=idx - 1))
        elif rule.get("BYDAY") and not rule.get("BYMONTHDAY"):
            for month in range(1, 13):
                out.extend(date(year, month, d) for d in _month_byday_days(year, month, rule["BYDAY"]))
        else:
            try:
                out.append(date(year, anchor.month, anchor.day))
            except ValueError:
                pass
        return _apply_setpos(sorted(set(out)), rule)
    return []


def _advance_period(freq: str, period_start: date, interval: int) -> date:
    if freq == "DAILY":
        return period_start + timedelta(days=interval)
    if freq == "WEEKLY":
        return period_start + timedelta(weeks=interval)
    if freq == "MONTHLY":
        month_index = period_start.year * 12 + (period_start.month - 1) + interval
        return date(month_index // 12, month_index % 12 + 1, 1)
    return date(period_start.year + interval, 1, 1)


def _first_period(freq: str, anchor: date, wkst: int) -> date:
    if freq == "WEEKLY":
        return anchor - timedelta(days=(anchor.weekday() - wkst) % 7)
    if freq == "MONTHLY":
        return date(anchor.year, anchor.month, 1)
    if freq == "YEARLY":
        return date(anchor.year, 1, 1)
    return anchor


def expand_starts(
    start: Any,
    all_day: bool,
    rule: dict[str, str],
    until_value: Any,
    range_end_utc: datetime,
    keep_from_utc: datetime | None = None,
) -> list[Any]:
    """Occurrence starts (dates for all-day, aware datetimes otherwise) up to range_end.

    Instances before keep_from_utc are still counted (COUNT=) but not returned, so long-running
    series never hit MAX_INSTANCES before reaching today.
    """
    freq = rule.get("FREQ", "").upper()
    if freq not in ("DAILY", "WEEKLY", "MONTHLY", "YEARLY"):
        return [start]
    try:
        interval = max(1, int(rule.get("INTERVAL") or 1))
    except ValueError:
        interval = 1
    try:
        count = int(rule["COUNT"]) if rule.get("COUNT") else None
    except ValueError:
        count = None
    wkst = WEEKDAYS.get(rule.get("WKST", "MO").upper(), 0)
    anchor: date = start if all_day else start.date()
    tz = None if all_day else start.tzinfo
    clock = time(0, 0) if all_day else start.timetz().replace(tzinfo=None)

    def build(d: date) -> Any:
        if all_day:
            return d
        return datetime.combine(d, clock).replace(tzinfo=tz)

    def past_until(value: Any) -> bool:
        if until_value is None:
            return False
        if isinstance(until_value, datetime):
            if isinstance(value, datetime):
                return value.astimezone(UTC) > until_value.astimezone(UTC)
            return value > until_value.astimezone(tz or UTC).date()
        if isinstance(value, datetime):
            return value.date() > until_value
        return value > until_value

    def past_range(value: Any) -> bool:
        if isinstance(value, datetime):
            return value.astimezone(UTC) > range_end_utc
        return datetime.combine(value, time(0, 0)).replace(tzinfo=UTC) > range_end_utc + timedelta(days=1)

    def worth_keeping(value: Any) -> bool:
        if keep_from_utc is None:
            return True
        if isinstance(value, datetime):
            return value.astimezone(UTC) >= keep_from_utc
        return datetime.combine(value, time(0, 0)).replace(tzinfo=UTC) >= keep_from_utc - timedelta(days=1)

    out: list[Any] = [start]
    produced = 1
    period = _first_period(freq, anchor, wkst)
    for _ in range(MAX_PERIODS):
        if count is not None and produced >= count:
            break
        if len(out) >= MAX_INSTANCES:
            break
        stop = False
        for d in _period_days(freq, period, rule, anchor, wkst):
            if d <= anchor:
                continue
            value = build(d)
            if past_until(value) or past_range(value):
                stop = True
                break
            if worth_keeping(value):
                out.append(value)
            produced += 1
            if count is not None and produced >= count:
                stop = True
                break
        if stop:
            break
        period = _advance_period(freq, period, interval)
        if past_range(build(period)):
            break
    return out


# --------------------------------------------------------------------------- events


def _instance_key(value: Any) -> str:
    if isinstance(value, datetime):
        return value.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
    if isinstance(value, date):
        return value.strftime("%Y%m%d")
    return ""


def _date_key(value: Any, tz: tzinfo) -> str:
    if isinstance(value, datetime):
        return value.astimezone(tz).strftime("%Y%m%d")
    if isinstance(value, date):
        return value.strftime("%Y%m%d")
    return ""


def _format(value: Any, all_day: bool, *, is_end: bool) -> str:
    if all_day:
        return f"{value.isoformat()}T23:59:59" if is_end else f"{value.isoformat()}T00:00:00"
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _event_bounds(start: Any, all_day: bool, end: Any, duration: timedelta | None) -> tuple[Any, Any]:
    """Returns (start, inclusive_end). For all-day, both are dates (end = last day shown)."""
    if all_day:
        if isinstance(end, date) and not isinstance(end, datetime) and end > start:
            last = end - timedelta(days=1)
        elif duration is not None and duration.days >= 1:
            last = start + timedelta(days=duration.days - 1)
        else:
            last = start
        return start, last
    if isinstance(end, datetime) and end >= start:
        return start, end
    if isinstance(end, date) and not isinstance(end, datetime):
        return start, datetime.combine(end, time(0, 0)).replace(tzinfo=start.tzinfo)
    if duration is not None:
        return start, start + duration
    return start, start


def parse_feed(
    data: bytes | str,
    *,
    tz_name: str = "America/Chicago",
    days_ahead: int = 21,
    now: datetime | None = None,
    days_back: int = 1,
) -> list[dict[str, Any]]:
    text = data.decode("utf-8", errors="replace") if isinstance(data, bytes) else data
    root = parse_components(text)

    vtimezones: dict[str, tzinfo] = {}
    for comp in walk(root, "VTIMEZONE"):
        tzid_prop = comp.get("TZID")
        if tzid_prop and tzid_prop.value.strip():
            vtimezones[tzid_prop.value.strip()] = VTimezone(tzid_prop.value.strip(), comp)

    home = household_tz(tz_name, vtimezones)
    floating_tz = home

    now_utc = (now or datetime.now(UTC)).astimezone(UTC)
    today_local = now_utc.astimezone(home).date()
    range_start_day = today_local - timedelta(days=days_back)
    range_start_utc = datetime.combine(range_start_day, time(0, 0)).replace(tzinfo=home).astimezone(UTC)
    range_end_utc = now_utc + timedelta(days=days_ahead)
    range_end_day = range_end_utc.astimezone(home).date()

    masters: list[Component] = []
    overrides: dict[str, dict[str, Component]] = {}
    for ev in walk(root, "VEVENT"):
        uid = (ev.get("UID").value.strip() if ev.get("UID") else "")
        rid_prop = ev.get("RECURRENCE-ID")
        if rid_prop and uid:
            rid, _ = parse_value(rid_prop, vtimezones, floating_tz)
            if rid is not None:
                overrides.setdefault(uid, {})[_instance_key(rid)] = ev
                continue
        masters.append(ev)

    out: list[dict[str, Any]] = []

    def overlaps(start: Any, last: Any, all_day: bool) -> bool:
        if all_day:
            return last >= range_start_day and start <= range_end_day
        return last.astimezone(UTC) >= range_start_utc and start.astimezone(UTC) <= range_end_utc

    def emit(ev: Component, start: Any, last: Any, all_day: bool, event_id: str) -> None:
        if not overlaps(start, last, all_day):
            return
        summary = ev.get("SUMMARY")
        location = ev.get("LOCATION")
        color = ev.get("COLOR") or ev.get("X-GOOGLE-CALENDAR-COLOR") or ev.get("X-APPLE-CALENDAR-COLOR")
        out.append(
            {
                "id": event_id,
                "title": unescape_text(summary.value).strip() if summary and summary.value.strip() else "(No title)",
                "start": _format(start, all_day, is_end=False),
                "end": _format(last, all_day, is_end=True),
                "allDay": all_day,
                "location": unescape_text(location.value).strip() if location else "",
                "color": color.value.strip() if color else "",
            }
        )

    def is_cancelled(ev: Component) -> bool:
        status = ev.get("STATUS")
        return bool(status and status.value.strip().upper() == "CANCELLED")

    for index, ev in enumerate(masters, 1):
        start, all_day = parse_value(ev.get("DTSTART"), vtimezones, floating_tz)
        if start is None:
            continue
        uid = ev.get("UID").value.strip() if ev.get("UID") else f"ics-{index}"
        end, _ = parse_value(ev.get("DTEND"), vtimezones, floating_tz)
        dur_prop = ev.get("DURATION")
        duration = parse_duration(dur_prop.value) if dur_prop else None
        first_start, first_last = _event_bounds(start, all_day, end, duration)
        span = first_last - first_start
        rrule_prop = ev.get("RRULE")

        if not rrule_prop:
            if not is_cancelled(ev):
                emit(ev, first_start, first_last, all_day, uid)
            continue

        rule = parse_rrule(rrule_prop.value)
        until_value = None
        if rule.get("UNTIL"):
            until_value, _ = parse_raw(rule["UNTIL"], {}, vtimezones, start.tzinfo if isinstance(start, datetime) else floating_tz)

        starts = expand_starts(start, all_day, rule, until_value, range_end_utc, range_start_utc - span_margin(span))
        for rdate_prop in ev.get_all("RDATE"):
            for part in rdate_prop.value.split(","):
                value, _ = parse_raw(part, rdate_prop.params, vtimezones, start.tzinfo if isinstance(start, datetime) else floating_tz)
                if value is not None and type(value) is type(start):
                    starts.append(value)

        excluded: set[str] = set()
        excluded_dates: set[str] = set()
        for ex_prop in ev.get_all("EXDATE"):
            for part in ex_prop.value.split(","):
                value, ex_all_day = parse_raw(part, ex_prop.params, vtimezones, start.tzinfo if isinstance(start, datetime) else floating_tz)
                if value is None:
                    continue
                if ex_all_day and not all_day:
                    excluded_dates.add(_date_key(value, home))
                else:
                    excluded.add(_instance_key(value))

        moved = overrides.get(uid, {})
        seen: set[str] = set()
        for occ in sorted(set(starts), key=lambda v: _instance_key(v)):
            key = _instance_key(occ)
            if key in seen or key in excluded:
                continue
            seen.add(key)
            if not all_day and _date_key(occ, home) in excluded_dates:
                continue
            if key in moved:
                continue
            if is_cancelled(ev):
                continue
            emit(ev, occ, occ + span, all_day, f"{uid}-{key}")

    for uid, by_key in overrides.items():
        for ev in by_key.values():
            if is_cancelled(ev):
                continue
            start, all_day = parse_value(ev.get("DTSTART"), vtimezones, floating_tz)
            if start is None:
                continue
            end, _ = parse_value(ev.get("DTEND"), vtimezones, floating_tz)
            dur_prop = ev.get("DURATION")
            duration = parse_duration(dur_prop.value) if dur_prop else None
            first_start, first_last = _event_bounds(start, all_day, end, duration)
            emit(ev, first_start, first_last, all_day, f"{uid}-{_instance_key(start)}")

    out.sort(key=lambda row: (row["start"], row["title"]))
    return out


def span_margin(span: timedelta) -> timedelta:
    return max(span, timedelta(0)) + timedelta(days=1)
