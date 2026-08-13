/* Touchscreen kiosk navigation — swipe-up drawer + auto-rotate across configured screens */
(function () {
  const params = new URLSearchParams(location.search);
  if (!params.has("kiosk")) return;

  const registry = window.FAMILY_SCREENS;
  if (!registry?.screens?.length) return;

  const allScreens = registry.screens.filter((s) => s.enabled !== false);
  if (!allScreens.length) return;

  const swipeThreshold = registry.swipeThreshold || 60;
  const bottomZonePx = 56;
  const autoHideMs = 5000;
  const defaultSeconds = Math.max(5, Number(registry.rotationSeconds) || 45);
  const defaultPauseMs = Math.max(0, (registry.pauseOnTouchSeconds || 120) * 1000);

  const currentPath = location.pathname;
  const isWhiteboardPage = currentPath.includes("whiteboard");
  const currentScreen =
    allScreens.find((s) => currentPath.endsWith(s.path.replace(/^\//, ""))) || allScreens[0];

  let rotationSettings = null;
  let pauseMs = defaultPauseMs;
  let pauseUntil = 0;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartId = null;
  let touchFromBottom = false;
  let touchActive = false;
  let rotateTimer = null;
  let hideTimer = null;

  function defaultRotationSettings() {
    const screens = {};
    allScreens.forEach((s) => {
      screens[s.id] = { enabled: true, seconds: defaultSeconds };
    });
    return { pauseOnTouchSeconds: registry.pauseOnTouchSeconds || 120, screens };
  }

  function screenConfig(id) {
    const cfg = rotationSettings?.screens?.[id];
    return {
      enabled: cfg?.enabled !== false,
      seconds: Math.max(5, Number(cfg?.seconds) || defaultSeconds),
    };
  }

  function rotationQueue() {
    return allScreens.filter((s) => screenConfig(s.id).enabled);
  }

  function viewportHeight() {
    return window.visualViewport?.height ?? window.innerHeight;
  }

  function inBottomZone(y) {
    return y >= viewportHeight() - bottomZonePx;
  }

  function goToId(id) {
    const target = allScreens.find((s) => s.id === id);
    if (!target || target.id === currentScreen.id) return;
    location.href = `${target.path}?kiosk=1`;
  }

  function goToAllOffset(delta) {
    const i = allScreens.findIndex((s) => s.id === currentScreen.id);
    if (i < 0) return;
    const next = allScreens[((i + delta) % allScreens.length + allScreens.length) % allScreens.length];
    goToId(next.id);
  }

  function goToNextRotation() {
    const queue = rotationQueue();
    if (queue.length < 2) return;
    const ri = queue.findIndex((s) => s.id === currentScreen.id);
    const next = queue[ri < 0 ? 0 : (ri + 1) % queue.length];
    goToId(next.id);
  }

  function scheduleRotation() {
    clearTimeout(rotateTimer);
    const queue = rotationQueue();
    if (queue.length < 2) return;
    const ri = queue.findIndex((s) => s.id === currentScreen.id);
    if (ri < 0) return;

    const ms = screenConfig(currentScreen.id).seconds * 1000;
    rotateTimer = setTimeout(() => {
      if (Date.now() < pauseUntil) {
        scheduleRotation();
        return;
      }
      goToNextRotation();
    }, ms);
  }

  function bumpPause() {
    pauseUntil = Date.now() + pauseMs;
    scheduleRotation();
  }

  function resetTouch() {
    touchStartX = 0;
    touchStartY = 0;
    touchStartId = null;
    touchFromBottom = false;
    touchActive = false;
  }

  function renderNav() {
    nav.innerHTML = allScreens
      .map((s) => {
        const inRotation = screenConfig(s.id).enabled;
        return `<button type="button" class="kiosk-dot${s.id === currentScreen.id ? " active" : ""}${
          inRotation ? "" : " off-rotation"
        }" data-id="${s.id}" aria-label="${s.title}" title="${s.title}${
          inRotation ? "" : " (not in rotation)"
        }">${s.icon}</button>`;
      })
      .join("");

    nav.querySelectorAll(".kiosk-dot").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        bumpPause();
        scheduleHide();
        goToId(btn.dataset.id);
      });
    });
  }

  function applyRotationSettings() {
    pauseMs = Math.max(0, Number(rotationSettings?.pauseOnTouchSeconds ?? 120) * 1000);
    renderNav();
    scheduleRotation();
  }

  async function loadRotationSettings() {
    if (window.FamilyAPI?.getState) {
      try {
        const data = await FamilyAPI.getState();
        if (data.settings?.rotation) {
          rotationSettings = data.settings.rotation;
        }
      } catch {
        /* offline */
      }
    }
    if (!rotationSettings) rotationSettings = defaultRotationSettings();
    applyRotationSettings();
  }

  const drawer = document.createElement("div");
  drawer.className = "kiosk-nav-drawer";
  drawer.setAttribute("aria-hidden", "true");

  const nav = document.createElement("nav");
  nav.className = "kiosk-nav";
  nav.setAttribute("aria-label", "Screen navigation");

  drawer.appendChild(nav);
  document.body.appendChild(drawer);
  document.body.classList.add("has-kiosk-nav");

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideDrawer, autoHideMs);
  }

  function showDrawer() {
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    scheduleHide();
  }

  function hideDrawer() {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    clearTimeout(hideTimer);
  }

  function onTouchStart(e) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    touchActive = true;
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    touchStartId = t.identifier;
    touchFromBottom = inBottomZone(t.clientY);
  }

  function onTouchEnd(e) {
    if (!touchActive) return;

    const t =
      [...e.changedTouches].find((c) => c.identifier === touchStartId) || e.changedTouches[0];
    if (!t) {
      resetTouch();
      return;
    }

    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    const fromBottom = touchFromBottom;
    const drawerOpen = drawer.classList.contains("open");
    resetTouch();

    bumpPause();

    if (fromBottom && dy < -swipeThreshold && Math.abs(dy) > Math.abs(dx)) {
      showDrawer();
      return;
    }

    if (drawerOpen && dy > swipeThreshold && Math.abs(dy) > Math.abs(dx)) {
      hideDrawer();
      return;
    }

    if (isWhiteboardPage || drawerOpen) return;

    if (Math.abs(dx) < swipeThreshold || Math.abs(dx) < Math.abs(dy)) return;
    if (dx < 0) goToAllOffset(1);
    else goToAllOffset(-1);
  }

  drawer.addEventListener("pointerdown", () => scheduleHide());
  drawer.addEventListener("touchstart", () => scheduleHide(), { passive: true });

  document.addEventListener("touchstart", onTouchStart, { passive: true });
  document.addEventListener("touchend", onTouchEnd, { passive: true });
  document.addEventListener("touchcancel", resetTouch, { passive: true });

  document.addEventListener("kiosk-interaction", bumpPause);

  document.addEventListener(
    "click",
    (e) => {
      if (e.target.closest(".kiosk-nav-drawer")) return;
      bumpPause();
    },
    true
  );

  document.addEventListener("family-settings-update", (e) => {
    if (!e.detail?.rotation) return;
    rotationSettings = e.detail.rotation;
    applyRotationSettings();
  });

  renderNav();
  loadRotationSettings();
})();
