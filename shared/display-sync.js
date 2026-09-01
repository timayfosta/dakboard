/* Poll server revision; broadcast state when admin or API changes data */
(function () {
  const inEmbed = new URLSearchParams(location.search).has("embed");
  const inFrame = new URLSearchParams(location.search).has("frame");
  const isKiosk = new URLSearchParams(location.search).has("kiosk");
  const POLL_MS = inEmbed || inFrame || isKiosk ? 5000 : 2000;
  let lastRevision = -1;
  let syncing = false;
  let showSyncTimer = null;

  function isActiveDisplay() {
    if (document.visibilityState !== "visible") return false;
    if (new URLSearchParams(location.search).has("embed")) return true;
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

  function whenActive(fn) {
    return function (...args) {
      if (isActiveDisplay()) return fn.apply(this, args);
    };
  }

  function detectScope() {
    const path = location.pathname;
    if (path.includes("chores")) return "chores";
    if (path.includes("rewards")) return "rewards";
    if (path.includes("calendar")) return "calendar";
    return "full";
  }

  async function sync() {
    if (!isActiveDisplay() || syncing) return;
    syncing = true;
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
    } finally {
      syncing = false;
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
      if (e.data?.type === "fb-kiosk-shown") {
        clearTimeout(showSyncTimer);
        showSyncTimer = setTimeout(sync, 400);
      }
    });
  }

  window.DisplayActive = { isActive: isActiveDisplay, whenActive };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
