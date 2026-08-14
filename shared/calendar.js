/* Google Calendar: private proxy (preferred), public API key, or demo fallback */
(function () {
  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  function parseDemoStamp(stamp) {
    const m = String(stamp).match(/^today\+(\d+)(?:T(\d{2}):(\d{2}))?$/);
    if (!m) return new Date(stamp);
    const day = addDays(startOfDay(new Date()), Number(m[1]));
    if (m[2] != null) day.setHours(Number(m[2]), Number(m[3]), 0, 0);
    return day;
  }

  function normalizeEvent(ev) {
    return {
      id: ev.id || `${ev.title}-${ev.start.getTime()}`,
      title: ev.title,
      start: ev.start instanceof Date ? ev.start : new Date(ev.start),
      end: ev.end instanceof Date ? ev.end : new Date(ev.end || ev.start),
      allDay: !!ev.allDay,
      location: ev.location || "",
    };
  }

  function demoEvents(cfg) {
    return (cfg.demoEvents || []).map((e, i) => {
      const start = parseDemoStamp(e.start);
      const end = parseDemoStamp(e.end || e.start);
      if (e.allDay) {
        start.setHours(0, 0, 0, 0);
        end.setHours(23, 59, 59, 0);
      }
      return normalizeEvent({
        id: `demo-${i}`,
        title: e.title,
        start,
        end,
        allDay: !!e.allDay,
      });
    });
  }

  function unfoldIcsLines(text) {
    return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  }

  function unescapeIcs(value) {
    return String(value || "")
      .replace(/\\n/gi, "\n")
      .replace(/\\,/g, ",")
      .replace(/\\;/g, ";")
      .replace(/\\\\/g, "\\");
  }

  function parseIcsDate(value, params) {
    if (!value) return { date: new Date(), allDay: false };
    const raw = String(value).trim();
    const p = String(params || "");
    if (p.includes("VALUE=DATE") || /^\d{8}$/.test(raw)) {
      const y = Number(raw.slice(0, 4));
      const m = Number(raw.slice(4, 6)) - 1;
      const d = Number(raw.slice(6, 8));
      return { date: new Date(y, m, d), allDay: true };
    }
    // 20260812T170000Z or 20260812T170000
    const m = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
    if (!m) return { date: new Date(raw), allDay: false };
    if (m[7] === "Z") {
      return {
        date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])),
        allDay: false,
      };
    }
    return {
      date: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]),
      allDay: false,
    };
  }

  const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

  function parseRrule(value) {
    const out = {};
    String(value || "")
      .replace(/^RRULE:/i, "")
      .split(";")
      .forEach((part) => {
        const idx = part.indexOf("=");
        if (idx < 0) return;
        out[part.slice(0, idx).toUpperCase()] = part.slice(idx + 1);
      });
    return out;
  }

  function dayKeyLocal(d) {
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function expandRrule(master, rangeStart, rangeEnd) {
    const rule = parseRrule(master.rrule);
    const freq = (rule.FREQ || "").toUpperCase();
    if (!freq) return [master];

    const interval = Math.max(1, parseInt(rule.INTERVAL || "1", 10) || 1);
    const count = rule.COUNT ? parseInt(rule.COUNT, 10) : null;
    const until = rule.UNTIL
      ? parseIcsDate(rule.UNTIL, /^\d{8}$/.test(rule.UNTIL) ? "VALUE=DATE" : "").date
      : null;
    const durationMs = Math.max(0, master.end - master.start);
    const exset = new Set((master.exdates || []).map(dayKeyLocal));

    let byDays = null;
    if (rule.BYDAY) {
      byDays = rule.BYDAY.split(",")
        .map((token) => {
          const m = token.trim().match(/^(-?\d+)?([A-Z]{2})$/i);
          if (!m) return null;
          const dow = DOW[m[2].toUpperCase()];
          if (dow == null) return null;
          return { nth: m[1] ? parseInt(m[1], 10) : null, dow };
        })
        .filter(Boolean);
    }

    const occurrences = [];
    const emit = (startDate) => {
      if (startDate < rangeStart && startDate.getTime() + durationMs < rangeStart.getTime()) return;
      if (startDate > rangeEnd) return;
      if (until && startDate > until) return;
      if (exset.has(dayKeyLocal(startDate))) return;
      const endDate = new Date(startDate.getTime() + durationMs);
      occurrences.push(
        normalizeEvent({
          id: `${master.id}-${startDate.getTime()}`,
          title: master.title,
          start: startDate,
          end: endDate,
          allDay: master.allDay,
          location: master.location,
        })
      );
    };

    const matchesByDay = (d) => {
      if (!byDays || !byDays.length) return true;
      return byDays.some((b) => {
        if (b.dow !== d.getDay()) return false;
        if (b.nth == null) return true;
        // nth weekday of month (1=first, -1=last)
        if (b.nth > 0) {
          return Math.floor((d.getDate() - 1) / 7) + 1 === b.nth;
        }
        const next = new Date(d);
        next.setDate(d.getDate() + 7);
        return next.getMonth() !== d.getMonth();
      });
    };

    let produced = 0;
    const hardCap = 800;

    if (freq === "WEEKLY" && byDays && byDays.length) {
      // Walk day-by-day from master start; honor INTERVAL in weeks from series start week
      const seriesStart = startOfDay(master.start);
      let cursor = new Date(master.start);
      // Rewind a bit so we don't miss same-week days before DTSTART time-of-day pattern
      cursor = startOfDay(cursor);
      while (cursor <= rangeEnd && produced < hardCap && (count == null || produced < count)) {
        if (until && cursor > until) break;
        if (cursor >= seriesStart && matchesByDay(cursor)) {
          const weekDiff = Math.floor((startOfDay(cursor) - seriesStart) / 86400000 / 7);
          if (weekDiff % interval === 0) {
            const occStart = master.allDay
              ? startOfDay(cursor)
              : new Date(
                  cursor.getFullYear(),
                  cursor.getMonth(),
                  cursor.getDate(),
                  master.start.getHours(),
                  master.start.getMinutes(),
                  master.start.getSeconds()
                );
            if (occStart >= master.start || dayKeyLocal(occStart) === dayKeyLocal(master.start)) {
              if (!until || occStart <= until) {
                emit(occStart);
                produced += 1;
              }
            }
          }
        }
        cursor = addDays(cursor, 1);
      }
      return occurrences;
    }

    // DAILY / WEEKLY (no BYDAY) / MONTHLY / YEARLY — step from DTSTART
    let cursor = new Date(master.start);
    while (cursor <= rangeEnd && produced < hardCap && (count == null || produced < count)) {
      if (until && cursor > until) break;
      if (cursor >= master.start) {
        emit(new Date(cursor));
        produced += 1;
      }
      const next = new Date(cursor);
      if (freq === "DAILY") next.setDate(next.getDate() + interval);
      else if (freq === "WEEKLY") next.setDate(next.getDate() + 7 * interval);
      else if (freq === "MONTHLY") next.setMonth(next.getMonth() + interval);
      else if (freq === "YEARLY") next.setFullYear(next.getFullYear() + interval);
      else break;
      if (+next === +cursor) break;
      cursor = next;
    }
    return occurrences;
  }

  function parseIcs(text, daysAhead = 21) {
    const flat = unfoldIcsLines(text);
    const blocks = flat.split("BEGIN:VEVENT").slice(1);
    const rangeStart = addDays(startOfDay(new Date()), -1);
    const rangeEnd = addDays(new Date(), daysAhead);
    const events = [];

    blocks.forEach((block, i) => {
      const chunk = block.split("END:VEVENT")[0];
      const get = (key) => {
        const re = new RegExp(`^${key}(;[^:]*)?:(.*)$`, "mi");
        const match = chunk.match(re);
        if (!match) return null;
        return { params: match[1] || "", value: match[2].trim() };
      };
      const getAll = (key) => {
        const re = new RegExp(`^${key}(;[^:]*)?:(.*)$`, "gmi");
        const rows = [];
        let match;
        while ((match = re.exec(chunk))) {
          rows.push({ params: match[1] || "", value: match[2].trim() });
        }
        return rows;
      };

      const summary = get("SUMMARY");
      const dtStart = get("DTSTART");
      const dtEnd = get("DTEND");
      const uid = get("UID");
      const loc = get("LOCATION");
      const rrule = get("RRULE");
      const recurrenceId = get("RECURRENCE-ID");
      if (!dtStart) return;

      const start = parseIcsDate(dtStart.value, dtStart.params || "");
      const end = dtEnd
        ? parseIcsDate(dtEnd.value, dtEnd.params || "")
        : { date: new Date(start.date), allDay: start.allDay };
      if (start.allDay && !dtEnd) {
        end.date = new Date(start.date);
        end.date.setHours(23, 59, 59, 0);
      }

      const exdates = [];
      getAll("EXDATE").forEach((row) => {
        row.value.split(",").forEach((part) => {
          const parsed = parseIcsDate(part.trim(), row.params || "");
          if (parsed?.date) exdates.push(parsed.date);
        });
      });

      const base = {
        id: (uid && uid.value) || `ics-${i}`,
        title: unescapeIcs((summary && summary.value) || "(No title)"),
        start: start.date,
        end: end.date,
        allDay: start.allDay,
        location: unescapeIcs((loc && loc.value) || ""),
        rrule: rrule ? rrule.value : "",
        exdates,
      };

      // Exception / single instance overrides — keep as one-off
      if (recurrenceId || !base.rrule) {
        if (base.end >= rangeStart && base.start <= rangeEnd) {
          events.push(normalizeEvent(base));
        }
        return;
      }

      expandRrule(base, rangeStart, rangeEnd).forEach((ev) => events.push(ev));
    });

    return events.sort((a, b) => a.start - b.start);
  }

  async function fetchViaProxy(cfg) {
    const { proxyUrl, daysAhead = 21 } = cfg.googleCalendar || {};
    if (!proxyUrl) return null;

    // Keep the proxy URL clean — extra query params are unused and can confuse tunnels
    const url = new URL(proxyUrl, window.location.origin);
    const CACHE_KEY = "family-board-ics-cache-v1";

    const parseFeed = (text) => {
      if (!text || !/BEGIN:(VCALENDAR|VEVENT)/i.test(text)) {
        throw new Error("Calendar proxy did not return an iCal feed");
      }
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), text }));
      } catch (_) {
        /* ignore quota */
      }
      const parsed = parseIcs(text, daysAhead);
      const horizon = addDays(new Date(), daysAhead);
      return parsed.filter((e) => e.start <= horizon);
    };

    try {
      const res = await fetch(url.toString(), { cache: "no-store" });
      const contentType = res.headers.get("content-type") || "";
      if (!res.ok) {
        let detail = `Calendar proxy HTTP ${res.status}`;
        if (contentType.includes("json")) {
          try {
            const err = await res.json();
            if (err?.error) detail = err.error;
          } catch (_) {
            /* ignore */
          }
        }
        throw new Error(detail);
      }
      if (contentType.includes("json")) {
        const data = await res.json();
        if (data?.error) throw new Error(data.error);
        const items = data.events || data.items || data;
        return (items || []).map((item) =>
          normalizeEvent({
            id: item.id,
            title: item.title || item.summary || "(No title)",
            start: item.start?.dateTime || item.start?.date || item.start,
            end: item.end?.dateTime || item.end?.date || item.end || item.start,
            allDay: !!(item.allDay || item.start?.date),
            location: item.location || "",
          })
        );
      }
      return parseFeed(await res.text());
    } catch (err) {
      // Fall back to last good ICS saved in the browser
      try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (raw) {
          const cached = JSON.parse(raw);
          if (cached?.text) return parseFeed(cached.text);
        }
      } catch (_) {
        /* ignore */
      }
      throw err;
    }
  }

  async function fetchGooglePublicApi(cfg) {
    const { apiKey, calendarId, daysAhead = 21, maxUpcoming = 15, proxyUrl } = cfg.googleCalendar || {};
    // Private calendars use the iCal proxy — public API key calls return 400/404 and confuse errors
    if (proxyUrl) return null;
    if (!apiKey || !calendarId) return null;

    const timeMin = new Date().toISOString();
    const timeMax = addDays(new Date(), daysAhead).toISOString();
    const params = new URLSearchParams({
      key: apiKey,
      timeMin,
      timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(Math.max(maxUpcoming, 25)),
    });

    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId
    )}/events?${params}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Google Calendar HTTP ${res.status}`);
    const data = await res.json();

    return (data.items || []).map((item) => {
      const allDay = !!item.start.date;
      const start = new Date(item.start.dateTime || `${item.start.date}T00:00:00`);
      const end = new Date(item.end.dateTime || `${item.end.date}T23:59:59`);
      return normalizeEvent({
        id: item.id,
        title: item.summary || "(No title)",
        start,
        end,
        allDay,
        location: item.location || "",
      });
    });
  }

  async function loadEvents(cfg) {
    let lastError = "";
    // 1) Private path via local/Cloudflare proxy (secret iCal)
    try {
      const viaProxy = await fetchViaProxy(cfg);
      if (viaProxy) return { source: "google-private", events: viaProxy, error: "" };
    } catch (err) {
      lastError = err?.message || String(err);
      console.warn("Calendar proxy failed.", err);
    }

    // 2) Public API key path (only works if calendar is public)
    try {
      const live = await fetchGooglePublicApi(cfg);
      if (live) return { source: "google-public", events: live, error: lastError };
    } catch (err) {
      lastError = err?.message || String(err);
      console.warn("Public Google Calendar fetch failed.", err);
    }

    return { source: "offline", events: [], error: lastError || "Google Calendar unavailable" };
  }

  function upcoming(events, limit) {
    const now = new Date();
    return events
      .filter((e) => e.end >= now || (e.allDay && e.end >= startOfDay(now)))
      .sort((a, b) => a.start - b.start)
      .slice(0, limit);
  }

  function formatEventWhen(ev) {
    const now = startOfDay(new Date());
    const day = startOfDay(ev.start);
    const diff = Math.round((day - now) / 86400000);
    let dayLabel;
    if (diff === 0) dayLabel = "Today";
    else if (diff === 1) dayLabel = "Tomorrow";
    else {
      dayLabel = ev.start.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
    }

    if (ev.allDay) return `${dayLabel} · All day`;
    const time = ev.start.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    return `${dayLabel} · ${time}`;
  }

  window.FamilyCalendar = {
    loadEvents,
    upcoming,
    formatEventWhen,
    startOfDay,
    addDays,
    parseIcs,
  };
})();
