/* Photo screensaver — idle timeout and/or scheduled slideshow */
(function () {
  const DEFAULTS = {
    enabled: false,
    idleMinutes: 5,
    slideSeconds: 12,
    scheduleEnabled: false,
    startTime: "22:00",
    endTime: "06:00",
  };
  const IDLE_KEY = "fb-last-interaction";
  const DISMISS_KEY = "fb-screensaver-dismiss";

  let config = { ...DEFAULTS };
  let settingsFp = "";
  let manifestFp = "";
  let photos = [];
  let slideSeconds = 12;
  let layer = null;
  let imgA = null;
  let imgB = null;
  let imgFront = 0;
  let slideIndex = 0;
  let slideTimer = null;
  let idleTimer = null;
  let active = false;
  let lastInteraction = readStoredTime(IDLE_KEY, Date.now());
  let dismissedUntil = readStoredTime(DISMISS_KEY, 0);
  let manifestLoading = false;
  let preloadImg = null;

  function readStoredTime(key, fallback) {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return fallback;
      const n = Number(raw);
      return Number.isFinite(n) ? n : fallback;
    } catch {
      return fallback;
    }
  }

  function storeTime(key, value) {
    try {
      sessionStorage.setItem(key, String(value));
    } catch {
      /* private mode */
    }
  }

  function idleMinutes() {
    const mins = Number(config.idleMinutes) || 0;
    if (config.enabled && mins === 0 && !config.scheduleEnabled) return 5;
    return mins;
  }

  function parseMins(hhmm) {
    const [h, m] = String(hhmm || "0:00").split(":").map(Number);
    return h * 60 + (m || 0);
  }

  function inScheduleWindow(now) {
    if (!config.scheduleEnabled) return false;
    const mins = now.getHours() * 60 + now.getMinutes();
    const start = parseMins(config.startTime);
    const end = parseMins(config.endTime);
    if (start === end) return false;
    if (start < end) return mins >= start && mins < end;
    return mins >= start || mins < end;
  }

  function inHiddenKioskFrame() {
    if (!new URLSearchParams(location.search).has("frame")) return false;
    try {
      return !window.frameElement?.classList.contains("on");
    } catch {
      return document.visibilityState !== "visible";
    }
  }

  function shouldShow(now) {
    if (inHiddenKioskFrame()) return false;
    if (!config.enabled) return false;
    if (now.getTime() < dismissedUntil) return false;
    if (!photos.length) return false;
    const scheduleHit = inScheduleWindow(now);
    const mins = idleMinutes();
    const idleHit = mins > 0 && now.getTime() - lastInteraction >= mins * 60 * 1000;
    return scheduleHit || idleHit;
  }

  function ensureLayer() {
    if (layer) return layer;
    layer = document.createElement("div");
    layer.className = "screensaver-layer";
    layer.id = "screensaverLayer";
    layer.setAttribute("aria-hidden", "true");
    layer.innerHTML =
      '<img class="ss-img ss-a" alt="" /><img class="ss-img ss-b" alt="" /><div class="ss-caption"></div>';
    document.body.appendChild(layer);
    imgA = layer.querySelector(".ss-a");
    imgB = layer.querySelector(".ss-b");
    preloadImg = new Image();
    layer.addEventListener("click", dismiss, true);
    layer.addEventListener("touchstart", dismiss, { passive: true, capture: true });
    return layer;
  }

  function dismiss() {
    dismissedUntil = Date.now() + 120000;
    storeTime(DISMISS_KEY, dismissedUntil);
    bumpInteraction();
    apply(false);
  }

  function bumpInteraction() {
    lastInteraction = Date.now();
    storeTime(IDLE_KEY, lastInteraction);
    if (active) {
      dismissedUntil = Date.now() + 120000;
      storeTime(DISMISS_KEY, dismissedUntil);
      apply(false);
    }
    scheduleIdleCheck();
  }

  function setCaption(text) {
    const cap = layer?.querySelector(".ss-caption");
    if (cap) cap.textContent = text || "";
  }

  function preloadNext(fromIndex) {
    if (!photos.length || !preloadImg) return;
    const next = photos[(fromIndex + 1) % photos.length];
    if (next?.url) preloadImg.src = next.url;
  }

  function revealSlide(nextImg, prevImg) {
    nextImg.classList.add("visible");
    prevImg.classList.remove("visible");
    imgFront = nextImg === imgA ? 0 : 1;
  }

  function showSlide(i) {
    if (!photos.length) return;
    slideIndex = ((i % photos.length) + photos.length) % photos.length;
    const photo = photos[slideIndex];
    const nextImg = imgFront === 0 ? imgB : imgA;
    const prevImg = imgFront === 0 ? imgA : imgB;
    const url = photo.url;

    const done = () => {
      revealSlide(nextImg, prevImg);
      preloadNext(slideIndex);
    };

    if (nextImg.dataset.ssSrc === url && nextImg.complete && nextImg.naturalWidth > 0) {
      done();
      setCaption(photo.label || "");
      return;
    }

    nextImg.onload = () => {
      nextImg.dataset.ssSrc = url;
      done();
    };
    nextImg.onerror = () => {
      nextImg.dataset.ssSrc = "";
      done();
    };
    nextImg.src = url;
    setCaption(photo.label || "");
  }

  function startSlideshow() {
    clearInterval(slideTimer);
    if (!photos.length) return;
    showSlide(slideIndex);
    slideTimer = setInterval(() => showSlide(slideIndex + 1), slideSeconds * 1000);
  }

  function stopSlideshow() {
    clearInterval(slideTimer);
    slideTimer = null;
  }

  function apply(forceState) {
    ensureLayer();
    const next = typeof forceState === "boolean" ? forceState : shouldShow(new Date());
    if (next === active) return;
    active = next;
    layer.classList.toggle("active", active);
    document.body.classList.toggle("screensaver-on", active);
    if (active) startSlideshow();
    else stopSlideshow();
  }

  function scheduleIdleCheck() {
    clearTimeout(idleTimer);
    if (!config.enabled) return;
    if (inScheduleWindow(new Date())) {
      apply();
      return;
    }
    const mins = idleMinutes();
    if (!mins) return;
    const remaining = mins * 60 * 1000 - (Date.now() - lastInteraction);
    if (remaining <= 0) {
      apply();
      return;
    }
    idleTimer = setTimeout(() => apply(), remaining + 200);
  }

  async function refreshManifest(force = false) {
    if (manifestLoading || !window.FamilyAPI?.getScreensaverManifest) return;
    manifestLoading = true;
    try {
      const data = await FamilyAPI.getScreensaverManifest();
      const nextPhotos = data.photos || [];
      const fp = JSON.stringify(nextPhotos.map((p) => p.id));
      if (!force && fp === manifestFp) return;
      manifestFp = fp;
      photos = nextPhotos;
      slideSeconds = Math.max(4, Number(data.slideSeconds) || 12);
      if (slideIndex >= photos.length) slideIndex = 0;
      if (active) startSlideshow();
      apply();
      scheduleIdleCheck();
    } catch {
      /* offline */
    } finally {
      manifestLoading = false;
    }
  }

  async function applySettings(screensaver) {
    const ss = { ...DEFAULTS, ...(screensaver || {}) };
    const fp = JSON.stringify(ss);
    const changed = fp !== settingsFp;
    if (changed) {
      settingsFp = fp;
      config = ss;
      slideIndex = 0;
      await refreshManifest(true);
    }
    apply();
    scheduleIdleCheck();
  }

  async function refreshSettings() {
    if (!window.FamilyAPI?.getState) return;
    try {
      const data = await FamilyAPI.getState();
      await applySettings(data.settings?.screensaver);
    } catch {
      /* offline */
    }
  }

  function init() {
    if (!document.body.classList.contains("tv-stage") && !document.body.classList.contains("wb-page")) {
      return;
    }
    const isKiosk = document.body.classList.contains("kiosk") || new URLSearchParams(location.search).has("kiosk");
    ensureLayer();
    refreshSettings();
    refreshManifest(true);
    document.addEventListener("family-settings-update", (e) => {
      applySettings(e.detail?.screensaver);
    });
    setInterval(() => refreshManifest(false), 300000);
    setInterval(() => apply(), 15000);

    ["click", "touchstart", "keydown"].forEach((evt) => {
      document.addEventListener(evt, bumpInteraction, { passive: true, capture: true });
    });
    if (!isKiosk) {
      document.addEventListener(
        "mousemove",
        () => {
          if (Date.now() - lastInteraction < 3000) return;
          bumpInteraction();
        },
        { passive: true, capture: true }
      );
    }
    document.addEventListener("kiosk-interaction", bumpInteraction);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        lastInteraction = Date.now();
        refreshSettings();
        apply();
      }
    });
    window.addEventListener("message", (e) => {
      if (e.origin !== location.origin) return;
      if (e.data?.type !== "fb-kiosk-shown") return;
      lastInteraction = Date.now();
      refreshSettings();
      apply();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
