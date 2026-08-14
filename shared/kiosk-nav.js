/* Touchscreen / mouse kiosk navigation — swipe drawer, rotate loop, admin swipe-down */
(function () {
  const params = new URLSearchParams(location.search);
  if (!params.has("kiosk")) return;

  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.altKey || (e.key !== "F4" && e.code !== "F4")) return;
      e.preventDefault();
      e.stopPropagation();
      window.close();
    },
    true
  );

  const registry = window.FAMILY_SCREENS;
  if (!registry?.screens?.length) return;

  const allScreens = registry.screens.filter((s) => s.enabled !== false);
  if (!allScreens.length) return;

  const mouseMode =
    params.has("mouse") ||
    params.get("input") === "mouse" ||
    localStorage.getItem("family-kiosk-mouse") === "1";

  const swipeThreshold = registry.swipeThreshold || 60;
  const bottomZonePx = 72;
  const topZonePx = 72;
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
  let pointerStartX = 0;
  let pointerStartY = 0;
  let pointerFromBottom = false;
  let pointerFromTop = false;
  let pointerActive = false;
  let pointerId = null;
  let rotateTimer = null;
  let hideTimer = null;

  if (mouseMode) {
    document.body.classList.add("kiosk-mouse");
    try {
      localStorage.setItem("family-kiosk-mouse", "1");
    } catch {}
  }

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
    const q = allScreens.filter((s) => screenConfig(s.id).enabled);
    return q.length ? q : allScreens.slice();
  }

  function viewportHeight() {
    return window.visualViewport?.height ?? window.innerHeight;
  }

  function inBottomZone(y) {
    return y >= viewportHeight() - bottomZonePx;
  }

  function inTopZone(y) {
    return y <= topZonePx;
  }

  function goToId(id) {
    const target = allScreens.find((s) => s.id === id);
    if (!target || target.id === currentScreen.id) return;
    const q = mouseMode ? "&mouse=1" : "";
    location.href = `${target.path}?kiosk=1${q}`;
  }

  function goToAllOffset(delta) {
    const i = allScreens.findIndex((s) => s.id === currentScreen.id);
    if (i < 0) return;
    const next = allScreens[((i + delta) % allScreens.length + allScreens.length) % allScreens.length];
    goToId(next.id);
  }

  function goToNextRotation() {
    const queue = rotationQueue();
    if (queue.length < 2) {
      scheduleRotation();
      return;
    }
    const ri = queue.findIndex((s) => s.id === currentScreen.id);
    // Wrap: after last screen, go back to first
    const next = queue[ri < 0 ? 0 : (ri + 1) % queue.length];
    if (!next) return;
    if (next.id === currentScreen.id) {
      scheduleRotation();
      return;
    }
    goToId(next.id);
  }

  function scheduleRotation() {
    clearTimeout(rotateTimer);
    const queue = rotationQueue();
    if (queue.length < 2) return;

    const cfgSeconds =
      queue.some((s) => s.id === currentScreen.id)
        ? screenConfig(currentScreen.id).seconds
        : defaultSeconds;

    rotateTimer = setTimeout(() => {
      if (Date.now() < pauseUntil) {
        scheduleRotation();
        return;
      }
      goToNextRotation();
    }, cfgSeconds * 1000);
  }

  function bumpPause() {
    pauseUntil = Date.now() + pauseMs;
    scheduleRotation();
  }

  function openAdmin() {
    const q = mouseMode ? "?mouse=1" : "";
    location.href = `/admin/${q}`;
  }

  function resetPointer() {
    pointerStartX = 0;
    pointerStartY = 0;
    pointerFromBottom = false;
    pointerFromTop = false;
    pointerActive = false;
    pointerId = null;
  }

  function renderNav() {
    nav.innerHTML = allScreens
      .map((s) => {
        const inRotation = screenConfig(s.id).enabled;
        return `<button type="button" class="kiosk-dot${s.id === currentScreen.id ? " active" : ""}${
          inRotation ? "" : " off-rotation"
        }" data-id="${s.id}" aria-label="${s.title}" title="${s.title}${
          inRotation ? "" : " (not in rotation)"
        }"><span class="emoji">${s.icon}</span></button>`;
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

  // Top edge hint for admin swipe
  const adminHint = document.createElement("div");
  adminHint.className = "kiosk-admin-edge";
  adminHint.setAttribute("aria-hidden", "true");
  document.body.appendChild(adminHint);

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

  function onPointerStart(clientX, clientY, id) {
    pointerActive = true;
    pointerId = id;
    pointerStartX = clientX;
    pointerStartY = clientY;
    pointerFromBottom = inBottomZone(clientY);
    pointerFromTop = inTopZone(clientY);
  }

  function onPointerEnd(clientX, clientY) {
    if (!pointerActive) return;

    const dx = clientX - pointerStartX;
    const dy = clientY - pointerStartY;
    const fromBottom = pointerFromBottom;
    const fromTop = pointerFromTop;
    const drawerOpen = drawer.classList.contains("open");
    resetPointer();

    bumpPause();

    // Swipe down from top edge → admin
    if (fromTop && dy > swipeThreshold && Math.abs(dy) > Math.abs(dx)) {
      openAdmin();
      return;
    }

    // Swipe up from bottom → screen nav drawer
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

  document.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      onPointerStart(t.clientX, t.clientY, t.identifier);
    },
    { passive: true }
  );
  document.addEventListener(
    "touchend",
    (e) => {
      const t =
        [...e.changedTouches].find((c) => c.identifier === pointerId) || e.changedTouches[0];
      if (!t) {
        resetPointer();
        return;
      }
      onPointerEnd(t.clientX, t.clientY);
    },
    { passive: true }
  );
  document.addEventListener("touchcancel", resetPointer, { passive: true });

  // Mouse / trackpad support for non-touch displays
  if (mouseMode) {
    document.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      onPointerStart(e.clientX, e.clientY, "mouse");
    });
    document.addEventListener("mouseup", (e) => {
      if (!pointerActive) return;
      onPointerEnd(e.clientX, e.clientY);
    });
    // Double-click top edge also opens admin
    document.addEventListener("dblclick", (e) => {
      if (inTopZone(e.clientY)) openAdmin();
    });
  }

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

  // Start rotating immediately with defaults (don't wait on network)
  rotationSettings = defaultRotationSettings();
  applyRotationSettings();
  loadRotationSettings();
})();
