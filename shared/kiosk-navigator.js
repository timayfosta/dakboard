/* Kiosk shell — every screen stays loaded in its own iframe; switching only reveals one (no reload, no black flash) */
(function () {
  const params = new URLSearchParams(location.search);
  if (!params.has("kiosk")) return;

  const registry = window.FAMILY_SCREENS;
  if (!registry?.screens?.length) return;

  const allScreens = registry.screens.filter((s) => s.enabled !== false);
  if (!allScreens.length) return;

  const mouseMode =
    params.has("mouse") ||
    params.get("input") === "mouse" ||
    localStorage.getItem("family-kiosk-mouse") === "1";

  const defaultSeconds = Math.max(5, Number(registry.rotationSeconds) || 45);
  const defaultPauseMs = Math.max(0, (registry.pauseOnTouchSeconds || 120) * 1000);
  const startId = params.get("start") || allScreens[0].id;
  const shell = document.getElementById("kioskShell");
  if (!shell) return;

  const FADE_MS = 440;
  const FAST_FADE_MS = 200;
  /* Screens post fb-screen-ready once their data is drawn; don't wait forever on a slow one. */
  const READY_TIMEOUT_MS = 3000;
  /* A parked (opacity 0) frame may need a moment to paint once it is placed under the front one. */
  const STAGE_SETTLE_MS = 80;

  const frames = new Map();
  let frontId = "";
  let stagedId = "";
  let rotationSettings = null;
  let pauseMs = defaultPauseMs;
  let pauseUntil = 0;
  let rotateTimer = null;
  let loadGen = 0;
  let swapTimer = 0;
  let swapCleanup = null;
  let preloadStarted = false;

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

  function screenUrl(id) {
    const screen = allScreens.find((s) => s.id === id);
    if (!screen) return "";
    const q = new URLSearchParams();
    q.set("kiosk", "1");
    q.set("embed", "1");
    if (mouseMode) q.set("mouse", "1");
    return `${screen.path}?${q}`;
  }

  function frontFrame() {
    return frames.get(frontId) || null;
  }

  function markReady(frame) {
    if (!frame || frame.dataset.ready === "1") return;
    frame.dataset.ready = "1";
    clearTimeout(Number(frame.dataset.readyTimer) || 0);
    const id = frame.dataset.screenId;
    if (id !== frontId && id !== stagedId) frame.classList.add("is-parked");
    frame.dispatchEvent(new Event("fb-ready"));
  }

  function whenReady(frame, fn) {
    if (frame.dataset.ready === "1") fn();
    else frame.addEventListener("fb-ready", fn, { once: true });
  }

  function ensureFrame(id) {
    let frame = frames.get(id);
    if (frame) return frame;
    frame = document.createElement("iframe");
    frame.className = "screen-frame";
    frame.title = "Family Board";
    frame.dataset.screenId = id;
    frame.dataset.ready = "0";
    frame.addEventListener("load", () => {
      frame.dataset.ready = "0";
      clearTimeout(Number(frame.dataset.readyTimer) || 0);
      frame.dataset.readyTimer = String(setTimeout(() => markReady(frame), READY_TIMEOUT_MS));
    });
    frame.src = screenUrl(id);
    shell.appendChild(frame);
    frames.set(id, frame);
    return frame;
  }

  function notifyShown(frame) {
    try {
      frame?.contentWindow?.postMessage({ type: "fb-kiosk-shown" }, location.origin);
    } catch {}
  }

  function afterFrames(count, fn) {
    if (count <= 0) {
      fn();
      return;
    }
    requestAnimationFrame(() => afterFrames(count - 1, fn));
  }

  function startPreload() {
    if (preloadStarted) return;
    preloadStarted = true;
    const startIndex = Math.max(0, allScreens.findIndex((s) => s.id === frontId));
    const queue = [];
    for (let i = 1; i < allScreens.length; i++) {
      queue.push(allScreens[(startIndex + i) % allScreens.length].id);
    }
    const next = () => {
      const id = queue.shift();
      if (!id) return;
      if (frames.has(id)) {
        next();
        return;
      }
      whenReady(ensureFrame(id), () => setTimeout(next, 250));
    };
    setTimeout(next, 600);
  }

  function finishFirstShow(frame, id) {
    frame.classList.remove("is-staged", "is-parked", "is-leaving");
    frame.classList.add("is-front");
    frontId = id;
    stagedId = "";
    scheduleRotation();
    startPreload();
  }

  function finishSwap(incoming, outgoing, id, fadeMs) {
    frontId = id;
    stagedId = "";
    outgoing.style.transitionDuration = `${fadeMs}ms`;
    outgoing.classList.add("is-leaving");
    swapCleanup = () => {
      swapCleanup = null;
      clearTimeout(swapTimer);
      incoming.classList.remove("is-staged");
      incoming.classList.add("is-front");
      outgoing.classList.remove("is-front", "is-leaving", "is-staged");
      outgoing.style.transitionDuration = "";
      outgoing.classList.add("is-parked");
    };
    swapTimer = setTimeout(swapCleanup, fadeMs + 20);
    scheduleRotation();
  }

  function unstage(id) {
    const frame = frames.get(id);
    if (!frame) return;
    frame.classList.remove("is-staged");
    if (frame.dataset.ready === "1") frame.classList.add("is-parked");
  }

  function show(id, opts = {}) {
    if (!allScreens.some((s) => s.id === id)) id = allScreens[0].id;
    if (swapCleanup) swapCleanup();

    if (stagedId && stagedId !== id) {
      unstage(stagedId);
      stagedId = "";
      loadGen++;
    }

    if (id === frontId) {
      notifyShown(frontFrame());
      scheduleRotation();
      return;
    }
    if (id === stagedId) return;

    const incoming = ensureFrame(id);
    const outgoing = frontFrame();
    const gen = ++loadGen;
    stagedId = id;
    incoming.classList.remove("is-parked", "is-leaving", "is-front");
    incoming.classList.add("is-staged");
    const stagedAt = performance.now();

    whenReady(incoming, () => {
      if (gen !== loadGen) return;
      notifyShown(incoming);
      const wait = Math.max(0, STAGE_SETTLE_MS - (performance.now() - stagedAt));
      setTimeout(() => {
        afterFrames(2, () => {
          if (gen !== loadGen) return;
          if (outgoing) finishSwap(incoming, outgoing, id, opts.fast ? FAST_FADE_MS : FADE_MS);
          else finishFirstShow(incoming, id);
        });
      }, wait);
    });
  }

  function goToNextRotation() {
    const queue = rotationQueue();
    if (queue.length < 2) {
      scheduleRotation();
      return;
    }
    const ri = queue.findIndex((s) => s.id === frontId);
    const next = queue[ri < 0 ? 0 : (ri + 1) % queue.length];
    if (!next) return;
    show(next.id);
  }

  function scheduleRotation() {
    clearTimeout(rotateTimer);
    const queue = rotationQueue();
    if (queue.length < 2) return;
    const cfgSeconds = queue.some((s) => s.id === frontId)
      ? screenConfig(frontId).seconds
      : defaultSeconds;
    rotateTimer = setTimeout(() => {
      if (Date.now() < pauseUntil) {
        scheduleRotation();
        return;
      }
      try {
        if (frontFrame()?.contentDocument?.querySelector(".touch-input-overlay.open")) {
          scheduleRotation();
          return;
        }
      } catch {}
      goToNextRotation();
    }, cfgSeconds * 1000);
  }

  function openAdmin() {
    const retQ = new URLSearchParams();
    retQ.set("kiosk", "1");
    retQ.set("start", frontId || startId);
    if (mouseMode) retQ.set("mouse", "1");
    try {
      sessionStorage.setItem("fb-kiosk-return", `/screens/kiosk.html?${retQ}`);
    } catch {}
    const q = new URLSearchParams();
    q.set("from", "kiosk");
    q.set("kiosk", "1");
    if (mouseMode) q.set("mouse", "1");
    location.href = `/admin/?${q}`;
  }

  function applyRotationSettings() {
    pauseMs = Math.max(0, Number(rotationSettings?.pauseOnTouchSeconds ?? 120) * 1000);
    scheduleRotation();
  }

  async function loadRotationSettings() {
    if (window.FamilyAPI?.getState) {
      try {
        const data = await FamilyAPI.getState({ scope: "calendar" });
        if (data.settings?.rotation) rotationSettings = data.settings.rotation;
        if (data.settings?.kioskTheme && window.KioskTheme) {
          window.KioskTheme.apply(data.settings.kioskTheme);
        }
      } catch {
        /* offline */
      }
    }
    if (!rotationSettings) rotationSettings = defaultRotationSettings();
    applyRotationSettings();
  }

  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin) return;
    const data = e.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "fb-screen-ready") {
      for (const frame of frames.values()) {
        if (frame.contentWindow === e.source) {
          markReady(frame);
          break;
        }
      }
      return;
    }
    if (data.type === "fb-kiosk-go" && data.id) show(data.id, { fast: true });
    if (data.type === "fb-kiosk-admin") openAdmin();
    if (data.type === "fb-kiosk-pause") {
      pauseUntil = Date.now() + pauseMs;
      scheduleRotation();
    }
    if (data.type === "fb-kiosk-rotation" && data.rotation) {
      rotationSettings = data.rotation;
      applyRotationSettings();
    }
  });

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

  rotationSettings = defaultRotationSettings();
  show(startId);
  loadRotationSettings();
})();
