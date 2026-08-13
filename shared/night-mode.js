/* Night mode — dims display on schedule from server settings */
(function () {
  const DEFAULTS = { enabled: false, dimTime: "22:00", brightTime: "06:00", brightness: 15 };

  let config = { ...DEFAULTS };
  let layer = null;
  let settingsFp = "";
  let active = false;

  function parseMins(hhmm) {
    const [h, m] = String(hhmm || "0:00").split(":").map(Number);
    return h * 60 + (m || 0);
  }

  function inNightWindow(now) {
    if (!config.enabled) return false;
    const mins = now.getHours() * 60 + now.getMinutes();
    const dim = parseMins(config.dimTime);
    const bright = parseMins(config.brightTime);
    if (dim === bright) return false;
    if (dim < bright) return mins >= dim && mins < bright;
    return mins >= dim || mins < bright;
  }

  function ensureLayer() {
    if (layer) return layer;
    layer = document.createElement("div");
    layer.className = "night-mode-layer";
    layer.id = "nightModeLayer";
    layer.setAttribute("aria-hidden", "true");
    document.body.appendChild(layer);
    return layer;
  }

  function overlayOpacity() {
    const b = Math.max(1, Math.min(100, Number(config.brightness) || DEFAULTS.brightness));
    return 1 - b / 100;
  }

  function apply() {
    ensureLayer();
    const next = inNightWindow(new Date());
    active = next;
    const dim = overlayOpacity();
    document.documentElement.style.setProperty("--night-overlay-opacity", String(dim));
    layer.classList.toggle("active", active);
    document.body.classList.toggle("night-mode", active);
  }

  function msUntilNextBoundary() {
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    const secs = now.getSeconds();
    const targets = [parseMins(config.dimTime), parseMins(config.brightTime)];
    let best = Infinity;
    targets.forEach((t) => {
      let delta = (t - mins) * 60 - secs;
      if (delta <= 0) delta += 24 * 3600;
      if (delta < best) best = delta;
    });
    return best === Infinity ? 60000 : Math.max(1000, best * 1000 + 250);
  }

  function scheduleBoundaryCheck() {
    clearTimeout(scheduleBoundaryCheck._t);
    scheduleBoundaryCheck._t = setTimeout(() => {
      apply();
      scheduleBoundaryCheck();
    }, msUntilNextBoundary());
  }

  function applySettings(nightMode) {
    const nm = { ...DEFAULTS, ...(nightMode || {}) };
    const fp = JSON.stringify(nm);
    if (fp === settingsFp) return;
    settingsFp = fp;
    config = nm;
    apply();
    scheduleBoundaryCheck();
  }

  async function refreshSettings() {
    if (!window.FamilyAPI?.getState) return;
    try {
      const data = await FamilyAPI.getState();
      applySettings(data.settings?.nightMode);
    } catch {
      /* offline */
    }
  }

  function init() {
    if (!document.body.classList.contains("tv-stage") && !document.body.classList.contains("wb-page")) {
      return;
    }
    ensureLayer();
    apply();
    scheduleBoundaryCheck();
    refreshSettings();
    setInterval(apply, 15000);
    document.addEventListener("family-settings-update", (e) => {
      applySettings(e.detail?.nightMode);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") apply();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
