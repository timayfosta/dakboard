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

  function parseIcsDate(value, params) {
    if (!value) return { date: new Date(), allDay: false };
    if (params.includes("VALUE=DATE") || /^\d{8}$/.test(value)) {
      const y = Number(value.slice(0, 4));
      const m = Number(value.slice(4, 6)) - 1;
      const d = Number(value.slice(6, 8));
      return { date: new Date(y, m, d), allDay: true };
    }
    // 20260812T170000Z or 20260812T170000
    const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
    if (!m) return { date: new Date(value), allDay: false };
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

  function parseIcs(text) {
    const flat = unfoldIcsLines(text);
    const blocks = flat.split("BEGIN:VEVENT").slice(1);
    return blocks
      .map((block, i) => {
        const chunk = block.split("END:VEVENT")[0];
        const get = (key) => {
          const re = new RegExp(`^${key}(;[^:]*)?:(.*)$`, "mi");
          const match = chunk.match(re);
          if (!match) return null;
          return { params: match[1] || "", value: match[2].trim() };
        };
        const summary = get("SUMMARY");
        const dtStart = get("DTSTART");
        const dtEnd = get("DTEND");
        const uid = get("UID");
        const loc = get("LOCATION");
        if (!dtStart) return null;
        const start = parseIcsDate(dtStart.value, dtStart.params || "");
        const end = dtEnd
          ? parseIcsDate(dtEnd.value, dtEnd.params || "")
          : { date: new Date(start.date), allDay: start.allDay };
        return normalizeEvent({
          id: (uid && uid.value) || `ics-${i}`,
          title: (summary && summary.value) || "(No title)",
          start: start.date,
          end: end.date,
          allDay: start.allDay,
          location: (loc && loc.value) || "",
        });
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);
  }

  async function fetchViaProxy(cfg) {
    const { proxyUrl, daysAhead = 21, maxUpcoming = 15 } = cfg.googleCalendar || {};
    if (!proxyUrl) return null;

    const url = new URL(proxyUrl, window.location.origin);
    url.searchParams.set("daysAhead", String(daysAhead));
    url.searchParams.set("max", String(Math.max(maxUpcoming, 25)));

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Calendar proxy HTTP ${res.status}`);
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("json")) {
      const data = await res.json();
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
    const text = await res.text();
    const parsed = parseIcs(text);
    const horizon = addDays(new Date(), daysAhead);
    return parsed.filter((e) => e.start <= horizon);
  }

  async function fetchGooglePublicApi(cfg) {
    const { apiKey, calendarId, daysAhead = 21, maxUpcoming = 15 } = cfg.googleCalendar || {};
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
    // 1) Private path via Cloudflare Worker (secret iCal / OAuth)
    try {
      const viaProxy = await fetchViaProxy(cfg);
      if (viaProxy) return { source: "google-private", events: viaProxy };
    } catch (err) {
      console.warn("Calendar proxy failed.", err);
    }

    // 2) Public API key path (only works if calendar is public)
    try {
      const live = await fetchGooglePublicApi(cfg);
      if (live) return { source: "google-public", events: live };
    } catch (err) {
      console.warn("Public Google Calendar fetch failed.", err);
    }

    return { source: "demo", events: demoEvents(cfg) };
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
