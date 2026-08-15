/* Match calendar events to kids for color-coded agenda rows */
(function () {
  const FALLBACK_COLOR = "#8b909a";

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
    if (ev?.color) return ev.color;
    const kid = matchKid(ev?.title, kids);
    return kid?.color || FALLBACK_COLOR;
  }

  window.FamilyCalendarColors = { matchKid, resolveColor };
})();
