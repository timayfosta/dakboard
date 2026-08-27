/* Poll server revision; broadcast state when admin or API changes data */
(function () {
  const POLL_MS = 2000;
  let lastRevision = -1;

  function isActiveDisplay() {
    if (document.visibilityState !== "visible") return false;
    if (new URLSearchParams(location.search).has("frame")) {
      try {
        if (window.frameElement && !window.frameElement.classList.contains("on")) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  function detectScope() {
    const path = location.pathname;
    if (path.includes("chores")) return "chores";
    if (path.includes("rewards")) return "rewards";
    if (path.includes("calendar")) return "calendar";
    return "full";
  }

  async function sync() {
    if (!isActiveDisplay()) return;
    try {
      const res = await fetch("/api/family/revision", { cache: "no-store" });
      if (!res.ok) return;
      const { revision } = await res.json();
      if (revision === lastRevision) return;
      lastRevision = revision;

      if (!window.FamilyAPI?.getState) return;
      const scope = detectScope();
      const data = await FamilyAPI.getState(scope === "full" ? undefined : { scope });
      window.dispatchEvent(new CustomEvent("family-state-update", { detail: data }));
      window.dispatchEvent(
        new CustomEvent("family-settings-update", { detail: data.settings || {} })
      );
    } catch {
      /* offline */
    }
  }

  function isDisplayPage() {
    return (
      document.body.classList.contains("tv-stage") ||
      document.body.classList.contains("wb-page") ||
      document.body.classList.contains("kiosk") ||
      new URLSearchParams(location.search).has("kiosk")
    );
  }

  function init() {
    if (!isDisplayPage()) {
      return;
    }
    sync();
    setInterval(sync, POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") sync();
    });
    window.addEventListener("message", (e) => {
      if (e.origin !== location.origin) return;
      if (e.data?.type === "fb-kiosk-shown") sync();
    });
  }

  window.DisplayActive = { isActive: isActiveDisplay };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
