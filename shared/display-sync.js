/* Poll server revision; broadcast state when admin or API changes data */
(function () {
  const POLL_MS = 2000;
  let lastRevision = -1;

  async function sync() {
    try {
      const res = await fetch("/api/family/revision", { cache: "no-store" });
      if (!res.ok) return;
      const { revision } = await res.json();
      if (revision === lastRevision) return;
      lastRevision = revision;

      if (!window.FamilyAPI?.getState) return;
      const data = await FamilyAPI.getState();
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
