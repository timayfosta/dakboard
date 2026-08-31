/* Keep kiosk screens loaded in iframes — cycle by showing, not navigating */
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

  const frames = new Map();
  let currentId = "";
  let rotationSettings = null;
  let pauseMs = defaultPauseMs;
  let pauseUntil = 0;
  let rotateTimer = null;

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

  function nextRotationId(fromId = currentId) {
    const queue = rotationQueue();
    if (queue.length < 2) return null;
    const ri = queue.findIndex((s) => s.id === fromId);
    return queue[ri < 0 ? 0 : (ri + 1) % queue.length].id;
  }

  function frameUrl(id) {
    const screen = allScreens.find((s) => s.id === id);
    const q = new URLSearchParams();
    q.set("kiosk", "1");
    q.set("frame", "1");
    if (mouseMode) q.set("mouse", "1");
    return `${screen.path}?${q}`;
  }

  function ensureFrame(id) {
    if (frames.has(id)) return frames.get(id);
    const iframe = document.createElement("iframe");
    iframe.title = id;
    iframe.setAttribute("data-screen", id);
    iframe.src = frameUrl(id);
    shell.appendChild(iframe);
    frames.set(id, iframe);
    return iframe;
  }

  /** Once loaded, keep iframes in memory — destroying them freezes Pi Chromium */
  function trimFrames() {
    /* intentionally disabled */
  }

  function preloadNext() {
    const nextId = nextRotationId();
    if (!nextId || nextId === currentId) return;
    ensureFrame(nextId);
  }

  function show(id) {
    if (!allScreens.some((s) => s.id === id)) id = allScreens[0].id;
    currentId = id;
    ensureFrame(id);
    frames.forEach((el, key) => {
      el.classList.toggle("on", key === id);
    });
    preloadNext();
    trimFrames();
    try {
      frames.get(id)?.contentWindow?.postMessage({ type: "fb-kiosk-shown" }, location.origin);
    } catch {}
    scheduleRotation();
  }

  function goToNextRotation() {
    const queue = rotationQueue();
    if (queue.length < 2) {
      scheduleRotation();
      return;
    }
    const ri = queue.findIndex((s) => s.id === currentId);
    const next = queue[ri < 0 ? 0 : (ri + 1) % queue.length];
    if (!next) return;
    show(next.id);
  }

  function scheduleRotation() {
    clearTimeout(rotateTimer);
    const queue = rotationQueue();
    if (queue.length < 2) return;
    const cfgSeconds = queue.some((s) => s.id === currentId)
      ? screenConfig(currentId).seconds
      : defaultSeconds;
    rotateTimer = setTimeout(() => {
      if (Date.now() < pauseUntil) {
        scheduleRotation();
        return;
      }
      goToNextRotation();
    }, cfgSeconds * 1000);
  }

  function openAdmin() {
    const retQ = new URLSearchParams();
    retQ.set("kiosk", "1");
    retQ.set("start", currentId);
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
    preloadNext();
    trimFrames();
  }

  async function loadRotationSettings() {
    if (window.FamilyAPI?.getState) {
      try {
        const data = await FamilyAPI.getState();
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
    if (data.type === "fb-kiosk-go" && data.id) show(data.id);
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
