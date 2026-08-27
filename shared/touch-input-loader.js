/* Lazy-load touch keyboard assets on first use (Pi kiosk boot friendly) */
(function () {
  const VERSION = "4";
  let core = null;
  let loading = null;

  function assetBase() {
    const src = document.currentScript?.src;
    if (src) {
      const u = new URL(src, location.href);
      return u.pathname.replace(/[^/]+$/, "");
    }
    return "/shared/";
  }

  const BASE = assetBase();

  function loadStylesheet(href) {
    if (document.querySelector(`link[data-touch-input-css="${href}"]`)) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.dataset.touchInputCss = href;
      link.onload = () => resolve();
      link.onerror = () => reject(new Error(`Failed to load ${href}`));
      document.head.appendChild(link);
    });
  }

  function loadScript(src) {
    if (document.querySelector(`script[data-touch-input-js="${src}"]`)) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.dataset.touchInputJs = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  function ensureReady() {
    if (core) return Promise.resolve(core);
    if (!loading) {
      loading = (async () => {
        await loadStylesheet(`${BASE}touch-input.css?v=${VERSION}`);
        await loadScript(`${BASE}swipe-words.js`);
        await loadScript(`${BASE}touch-input.js?v=${VERSION}`);
        if (!core) {
          throw new Error("touch-input.js did not register");
        }
        return core;
      })().catch((err) => {
        loading = null;
        throw err;
      });
    }
    return loading;
  }

  function install(api) {
    core = api;
  }

  async function open(opts) {
    const ti = await ensureReady();
    return ti.open(opts);
  }

  async function close() {
    if (!core) return;
    return core.close();
  }

  async function attach() {
    const ti = await ensureReady();
    return ti.attach();
  }

  async function markTextFields(root) {
    const ti = await ensureReady();
    return ti.markTextFields(root);
  }

  window.TouchInput = { _install: install, ensureReady, open, close, attach, markTextFields };
})();
