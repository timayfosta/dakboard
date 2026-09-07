/* Match calendar events to kids for color-coded agenda rows */
(function () {
  const FALLBACK_COLOR = "#8b909a";

  function parseColorValue(raw) {
    if (raw == null || raw === "") return "";
    const v = String(raw).trim();
    const hex = v.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/i);
    if (hex) return hex[0];
    const GOOGLE = {
      1: "#a4bdfc",
      2: "#7ae7bf",
      3: "#dbadff",
      4: "#ff887c",
      5: "#fbd75b",
      6: "#ffb878",
      7: "#46d6db",
      8: "#e1e1e1",
      9: "#5484ed",
      10: "#51b749",
      11: "#dc2127",
    };
    return GOOGLE[v] || GOOGLE[Number(v)] || "";
  }

  function matchKid(title, kids) {
    if (!title || !kids?.length) return null;
    const lower = String(title).toLowerCase();
    const sorted = [...kids]
      .filter((k) => k.active !== false && k.name)
      .sort((a, b) => b.name.length - a.name.length);
    for (const kid of sorted) {
      const name = kid.name.toLowerCase();
      const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(lower)) return kid;
    }
    return null;
  }

  function resolveColor(ev, kids) {
    const fromEvent = parseColorValue(ev?.color);
    if (fromEvent) return fromEvent;
    const kid = matchKid(ev?.title, kids);
    if (kid?.color) return parseColorValue(kid.color) || kid.color;
    const cfgDefault = window.FAMILY_CONFIG?.googleCalendar?.defaultEventColor;
    return parseColorValue(cfgDefault) || cfgDefault || FALLBACK_COLOR;
  }

  window.FamilyCalendarColors = { matchKid, resolveColor, parseColorValue };
})();
