/* Kiosk day / night theme — contrast matches admin, driven by server settings */
(function () {
  const KEY = "family-kiosk-theme";

  function normalize(theme) {
    return theme === "day" ? "day" : "night";
  }

  function applyTheme(theme, persist) {
    const next = normalize(theme);
    const root = document.documentElement;
    const prev = root.getAttribute("data-theme");
    root.setAttribute("data-theme", next);
    if (persist !== false) {
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* private mode */
      }
    }
    if (prev !== next) {
      document.dispatchEvent(new CustomEvent("kiosk-theme-change", { detail: { theme: next } }));
    }
    return next;
  }

  try {
    applyTheme(localStorage.getItem(KEY) || "night", false);
  } catch {
    applyTheme("night", false);
  }

  function applyFromSettings(settings) {
    if (!settings || settings.kioskTheme == null) return;
    applyTheme(settings.kioskTheme, true);
  }

  async function refresh() {
    if (!window.FamilyAPI?.getState) return;
    try {
      const data = await FamilyAPI.getState();
      applyFromSettings(data.settings);
    } catch {
      /* offline */
    }
  }

  function isDisplayPage() {
    return (
      document.body?.classList.contains("tv-stage") ||
      document.body?.classList.contains("wb-page") ||
      document.body?.classList.contains("kiosk") ||
      new URLSearchParams(location.search).has("kiosk")
    );
  }

  function applyFromEvent(e) {
    const detail = e.detail || {};
    if (detail.kioskTheme != null) applyFromSettings(detail);
    else if (detail.settings) applyFromSettings(detail.settings);
  }

  function init() {
    if (!isDisplayPage()) return;
    refresh();
    window.addEventListener("family-settings-update", applyFromEvent);
    window.addEventListener("family-state-update", applyFromEvent);
    document.addEventListener("family-settings-update", applyFromEvent);
    document.addEventListener("family-state-update", applyFromEvent);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.KioskTheme = {
    apply: applyTheme,
    current: () => normalize(document.documentElement.getAttribute("data-theme")),
  };
})();
