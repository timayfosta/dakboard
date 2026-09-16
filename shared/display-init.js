/* Portrait canvas scaling — 1080×1920 design, fits any display */
(function () {
  const params = new URLSearchParams(location.search);
  const isEmbedKiosk = params.has("kiosk") && params.has("embed");

  if (isEmbedKiosk) {
    document.documentElement.classList.add("embed-boot");
  }

  try {
    const t = localStorage.getItem("family-kiosk-theme");
    if (t === "day" || t === "night") {
      document.documentElement.setAttribute("data-theme", t);
    }
  } catch {
    /* private mode */
  }

  const cfg = window.FAMILY_CONFIG?.display || { width: 1080, height: 1920 };
  const designW = Number(cfg.width) || 1080;
  const designH = Number(cfg.height) || 1920;
  let lastScale = null;
  let raf = 0;

  function applyScale() {
    const vw = window.visualViewport?.width ?? window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const scale = Math.round(Math.min(vw / designW, vh / designH) * 1000) / 1000;
    if (lastScale != null && Math.abs(scale - lastScale) < 0.002) return;
    lastScale = scale;
    const root = document.documentElement;
    root.style.setProperty("--tv-w", `${designW}px`);
    root.style.setProperty("--tv-h", `${designH}px`);
    root.style.setProperty("--tv-scale", String(scale));
  }

  function scheduleScale() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      applyScale();
    });
  }

  function ensureScaler() {
    const frame = document.querySelector(".tv-frame");
    if (!frame || frame.parentElement?.classList.contains("tv-scaler")) return;
    const scaler = document.createElement("div");
    scaler.className = "tv-scaler";
    frame.parentNode.insertBefore(scaler, frame);
    scaler.appendChild(frame);
  }

  function init() {
    ensureScaler();
    applyScale();
    if (isEmbedKiosk) revealEmbed();
  }

  function revealEmbed() {
    const reveal = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document.documentElement.classList.remove("embed-boot");
          document.documentElement.classList.add("embed-ready");
        });
      });
    };
    if (document.readyState === "complete") reveal();
    else window.addEventListener("load", reveal, { once: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  applyScale();
  window.addEventListener("resize", scheduleScale);
  window.visualViewport?.addEventListener("resize", scheduleScale);
  window.addEventListener("orientationchange", () => {
    lastScale = null;
    scheduleScale();
  });
})();
