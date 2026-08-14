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
  const edgeZonePx = registry.edgeSwipePx || 80;
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
  let pointerFromLeft = false;
  let pointerFromRight = false;
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

  function viewportSize() {
    return {
      w: window.visualViewport?.width ?? window.innerWidth,
      h: window.visualViewport?.height ?? window.innerHeight,
    };
  }

  function contentRect() {
    const el =
      document.querySelector(".tv-scaler") ||
      document.querySelector(".tv-frame") ||
      document.body;
    return el.getBoundingClientRect();
  }

  function inBottomZone(x, y) {
    const { h } = viewportSize();
    const frame = contentRect();
    return y >= h - edgeZonePx || y >= frame.bottom - edgeZonePx;
  }

  function inTopZone(x, y) {
    const frame = contentRect();
    return y <= edgeZonePx || y <= frame.top + edgeZonePx;
  }

  function inLeftZone(x) {
    const frame = contentRect();
    return x <= edgeZonePx || x <= frame.left + edgeZonePx;
  }

  function inRightZone(x) {
    const { w } = viewportSize();
    const frame = contentRect();
    return x >= w - edgeZonePx || x >= frame.right - edgeZonePx;
  }

  function ignoreGestureTarget(el) {
    return !!el?.closest?.(
      ".touch-input-overlay.open, .alert-overlay.show, .screensaver-layer.active"
    );
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
    pointerFromLeft = false;
    pointerFromRight = false;
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
    pointerFromBottom = inBottomZone(clientX, clientY);
    pointerFromTop = inTopZone(clientX, clientY);
    pointerFromLeft = inLeftZone(clientX);
    pointerFromRight = inRightZone(clientX);
  }

  function onPointerEnd(clientX, clientY) {
    if (!pointerActive) return;

    const dx = clientX - pointerStartX;
    const dy = clientY - pointerStartY;
    const fromBottom = pointerFromBottom;
    const fromTop = pointerFromTop;
    const fromLeft = pointerFromLeft;
    const fromRight = pointerFromRight;
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

    if (drawerOpen) return;
    if (window.Whiteboard?.isDrawing?.()) return;

    // Whiteboard: only change screens from left/right edges so drawing stays intact
    if (isWhiteboardPage && !fromLeft && !fromRight) return;

    if (Math.abs(dx) < swipeThreshold || Math.abs(dx) < Math.abs(dy)) return;
    if (dx < 0) goToAllOffset(1);
    else goToAllOffset(-1);
  }

  function onPointerDown(e) {
    if (e.isPrimary === false) return;
    if (e.button != null && e.button !== 0) return;
    if (ignoreGestureTarget(e.target)) return;
    if (e.target.closest?.(".kiosk-nav-drawer")) {
      scheduleHide();
      return;
    }

    onPointerStart(e.clientX, e.clientY, e.pointerId);

    // Claim whiteboard edge swipes before the canvas starts a stroke.
    // Leave the toolbar alone so its buttons still receive taps.
    const onToolbar = !!e.target.closest?.(".wb-toolbar");
    if (
      isWhiteboardPage &&
      (pointerFromTop || pointerFromLeft || pointerFromRight || (pointerFromBottom && !onToolbar))
    ) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onPointerUp(e) {
    if (!pointerActive) return;
    if (pointerId != null && e.pointerId !== pointerId) return;
    onPointerEnd(e.clientX, e.clientY);
  }

  const pointerOpts = { capture: true, passive: false };
  document.addEventListener("pointerdown", onPointerDown, pointerOpts);
  document.addEventListener("pointerup", onPointerUp, pointerOpts);
  document.addEventListener("pointercancel", resetPointer, pointerOpts);

  if (mouseMode) {
    document.addEventListener("dblclick", (e) => {
      if (inTopZone(e.clientX, e.clientY)) openAdmin();
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

  rotationSettings = defaultRotationSettings();
  applyRotationSettings();
  loadRotationSettings();
})();
