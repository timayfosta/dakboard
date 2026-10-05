/* Match calendar events to kids for color-coded agenda rows */
(function () {
  const FALLBACK_COLOR = "#8b909a";

  function parseColorValue(raw) {
    if (raw == null || raw === "") return "";
    const v = String(raw).trim();
    const hex = v.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/i);
    if (hex) return hex[0];
    const GOOGLE = {
      1: "#7986cb",
      2: "#33b679",
      3: "#8e24aa",
      4: "#e67c73",
      5: "#f6bf26",
      6: "#f4511e",
      7: "#039be5",
      8: "#616161",
      9: "#3f51b5",
      10: "#0b8043",
      11: "#d50000",
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
