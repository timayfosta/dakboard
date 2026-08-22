/* Auto-reload when the Family Board server restarts after a deploy/pull */
(function () {
  const BOOT_KEY = "family-board-boot-id";
  const STOP_KEY = "family-board-stopped";
  const POLL_MS = 2500;
  let sawDown = false;
  let timer = null;

  function halted() {
    try {
      return sessionStorage.getItem(STOP_KEY) === "1";
    } catch {
      return false;
    }
  }

  function stopPolling() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function tick() {
    if (halted()) {
      stopPolling();
      return;
    }
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) {
        sawDown = true;
        return;
      }
      const health = await res.json();
      if (!health?.ok || !health.bootId) return;
      try {
        sessionStorage.removeItem(STOP_KEY);
      } catch {}

      const prev = sessionStorage.getItem(BOOT_KEY);
      if (!prev) {
        sessionStorage.setItem(BOOT_KEY, health.bootId);
        sawDown = false;
        return;
      }

      const bootChanged = prev !== health.bootId;
      // Do not reload just because health flickered (Cloudflare / PWA). Only reload on a new server boot.
      if (bootChanged) {
        sessionStorage.setItem(BOOT_KEY, health.bootId);
        sawDown = false;
        try {
          if ("serviceWorker" in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map((r) => r.update()));
          }
        } catch {
          /* ignore */
        }
        location.reload();
        return;
      }
    } catch {
      sawDown = true;
    }
  }

  function start() {
    if (timer) return;
    if (halted()) return;
    if (new URLSearchParams(location.search).has("frame")) return;
    const kiosk =
      document.body.classList.contains("kiosk") ||
      new URLSearchParams(location.search).has("kiosk");
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;
    // Kiosk Chromium uses --app, which looks like standalone and used to skip
    // reload — the TV would keep old HTML until the kiosk service restarted.
    if (standalone && !kiosk) return;
    tick();
    timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") tick();
    });
    window.addEventListener("online", tick);
  }

  window.addEventListener("family-board-stop", () => {
    try {
      sessionStorage.setItem(STOP_KEY, "1");
    } catch {}
    stopPolling();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
