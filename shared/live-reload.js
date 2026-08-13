/* Auto-reload when the Family Board server restarts after a deploy/pull */
(function () {
  const BOOT_KEY = "family-board-boot-id";
  const POLL_MS = 2500;
  let sawDown = false;
  let timer = null;

  async function tick() {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) {
        sawDown = true;
        return;
      }
      const health = await res.json();
      if (!health?.ok || !health.bootId) return;

      const prev = sessionStorage.getItem(BOOT_KEY);
      if (!prev) {
        sessionStorage.setItem(BOOT_KEY, health.bootId);
        sawDown = false;
        return;
      }

      const bootChanged = prev !== health.bootId;
      if (bootChanged || sawDown) {
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
    tick();
    timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") tick();
    });
    window.addEventListener("online", tick);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
