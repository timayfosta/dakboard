(() => {
  (function bounceBlockedAdminPath() {
    const host = location.hostname;
    const path = location.pathname;
    if (!path.startsWith("/admin")) return;
    if (host === "127.0.0.1" || host === "localhost" || host.endsWith(".local")) return;
    if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return;
    location.replace("/phone/index.html" + location.search + location.hash);
  })();

  ["gesturestart", "gesturechange", "gestureend"].forEach((type) => {
    document.addEventListener(type, (event) => event.preventDefault());
  });

  const TOKEN_KEY = "family-admin-token";
  const THEME_KEY = "family-admin-theme";
  const FILES_TOKEN_KEY = "family-admin-files-token";
  const REQUIRED_API_VERSION = 3;
  const state = {
    token: localStorage.getItem(TOKEN_KEY) || "",
    tab: "lists",
    listFolder: "grocery",
    listCompletedOpen: false,
    data: null,
    deferredPrompt: null,
    listsFp: "",
    serverOk: true,
    serverHint: "",
    adminFiles: [],
    adminFileId: "",
    adminFile: null,
    browsePath: "",
    browseListing: null,
    filesToken: sessionStorage.getItem(FILES_TOKEN_KEY) || "",
    filesUnlocked: false,
    filesUnlockError: "",
  };
  let listPollTimer = null;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  function currentTheme() {
    const t = document.documentElement.getAttribute("data-theme");
    return t === "day" ? "day" : "night";
  }

  function applyTheme(theme) {
    const next = theme === "day" ? "day" : "night";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
    const meta = document.getElementById("metaThemeColor");
    if (meta) meta.setAttribute("content", next === "day" ? "#eef1f6" : "#000000");
    syncThemeButtons();
  }

  function syncThemeButtons() {
    const active = currentTheme();
    $$("[data-theme-set]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.themeSet === active);
    });
    syncKioskThemeButtons();
  }

  function currentKioskTheme() {
    return state.data?.settings?.kioskTheme === "day" ? "day" : "night";
  }

  function syncKioskThemeButtons() {
    const active = currentKioskTheme();
    $$("[data-kiosk-theme-set]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.kioskThemeSet === active);
    });
  }

  async function saveKioskTheme(theme) {
    const next = theme === "day" ? "day" : "night";
    if (!state.data) state.data = { settings: {} };
    if (!state.data.settings) state.data.settings = {};
    state.data.settings.kioskTheme = next;
    syncKioskThemeButtons();
    try {
      await AdminAPI.saveSettings(state.token, { kioskTheme: next });
      toast(next === "day" ? "Kiosk set to day" : "Kiosk set to night");
    } catch (err) {
      toast(apiErrorMessage(err));
      await refresh();
    }
  }

  document.addEventListener("click", (e) => {
    const kioskBtn = e.target.closest("[data-kiosk-theme-set]");
    if (kioskBtn) {
      saveKioskTheme(kioskBtn.dataset.kioskThemeSet);
      return;
    }
    const btn = e.target.closest("[data-theme-set]");
    if (!btn) return;
    applyTheme(btn.dataset.themeSet);
  });

  applyTheme(localStorage.getItem(THEME_KEY) || currentTheme());

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2200);
  }

  function setAuthed(on) {
    if (on) {
      $("#loginView")?.classList.add("hidden");
      $("#appView")?.classList.remove("hidden");
    } else {
      $("#loginView")?.classList.remove("hidden");
      $("#appView")?.classList.add("hidden");
    }
  }

  function logoutSession(message) {
    // Open admin — logging out just refreshes into the app again
    clearInterval(listPollTimer);
    if (message) toast(message);
    enterAdmin();
  }

  async function enterAdmin() {
    try {
      if (!state.token) {
        const res = await AdminAPI.login("");
        state.token = res.token;
        localStorage.setItem(TOKEN_KEY, res.token);
      } else {
        try {
          await AdminAPI.session(state.token);
        } catch {
          const res = await AdminAPI.login("");
          state.token = res.token;
          localStorage.setItem(TOKEN_KEY, res.token);
        }
      }
      setAuthed(true);
      await refresh();
      syncListPolling();
    } catch (err) {
      setAuthed(true);
      state.serverOk = false;
      state.serverHint = apiErrorMessage(err) || "Can't reach Family Board. Check the Pi server.";
      state.data = state.data || {
        kids: [],
        chores: [],
        consequences: [],
        lists: { grocery: [], reminders: [] },
        rewards: [],
        balances: {},
        today: "",
        settings: {},
      };
      render();
      toast(state.serverHint);
    }
  }

  function apiErrorMessage(err) {
    const msg = String(err?.message || err || "Save failed");
    if (msg.includes("Unauthorized") || msg.includes("401")) {
      return "Session expired — log in again";
    }
    if (msg.includes("Not found") || msg.includes("404")) {
      return "Server outdated — run: npm start";
    }
    return msg || "Save failed";
  }

  async function checkServer() {
    try {
      const health = await AdminAPI.health();
      const ok = health?.ok && Number(health.version) >= REQUIRED_API_VERSION;
      state.serverOk = ok;
      state.serverHint = ok
        ? ""
        : "Server needs restart. Stop the old python window, then run: npm start";
      return ok;
    } catch {
      state.serverOk = false;
      state.serverHint = "Can't reach server. Run: npm start";
      return false;
    }
  }

  function renderServerBanner() {
    let el = $("#serverBanner");
    if (!state.serverHint) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.id = "serverBanner";
      el.className = "server-banner";
      $("#appView").insertBefore(el, $("#tabContent"));
    }
    el.textContent = state.serverHint;
  }

  async function refresh() {
    await checkServer();
    state.data = await AdminAPI.state();
    state.listsFp = JSON.stringify(state.data.lists || {});
    render();
  }

  async function pollLists() {
    if (!state.token) return;
    try {
      const data = await AdminAPI.state();
      const fp = JSON.stringify(data.lists || {});
      if (fp === state.listsFp) return;
      state.listsFp = fp;
      state.data = data;
      if (state.tab === "lists") renderTab();
    } catch {
      /* server offline */
    }
  }

  function syncListPolling() {
    clearInterval(listPollTimer);
    if (!state.token) return;
    listPollTimer = setInterval(pollLists, 2500);
  }

  function kidName(id) {
    return state.data?.kids?.find((k) => k.id === id)?.name || id;
  }

  const KID_EMOJIS = [
    "🐻", "🦊", "🐼", "🐨", "🦁", "🐯", "🐸", "🐰",
    "🐶", "🐱", "🐺", "🐷", "🐮", "🐹", "🦎", "🐢",
    "🐙", "🦉", "🦋", "🌙", "⭐", "🍀", "🎯", "🧸",
    "📚", "⚽", "🎸", "🛹", "🎮", "🧩", "🪁", "🛸",
    "🐴", "🐑", "🐘", "🐊", "🦆", "🐧", "🦈", "🐳",
    "🦔", "🐿️", "🕊️", "🐌", "🦀", "🐞", "🪶", "🌿",
  ];

  const CHORE_EMOJIS = [
    "✅", "🛏️", "🍽️", "🧸", "📚", "🗑️", "🐾", "🌱", "👕", "👟", "📖", "🍴",
    "🧹", "🪥", "🚿", "🧺", "🪴", "📦", "🧼", "🚗", "🍳", "🎒", "🧴", "🛁",
    "🧽", "💡", "🔑", "🏠", "🍎", "🥛",
  ];

  const CONSEQUENCE_EMOJIS = [
    "⚠️", "😠", "🚫", "📵", "🧹", "📉", "🧊", "⏰", "📣", "💥",
    "👎", "🧯", "🪨", "🌧️", "😤", "🛑", "📌", "🔒", "📵", "🧹",
  ];

  const KID_COLORS = [
    "#C1121F", "#FF6B00", "#FFB703", "#008037", "#0077B6", "#023E8A",
    "#7209B7", "#6A040F", "#E85D04", "#03045E", "#F72585", "#2A9D8F",
    "#1B4332", "#40916C", "#B5179E", "#3C096C", "#FFBE0B", "#D62828",
  ];

  const CHECK_STYLES = [
    { id: "circle", label: "Circle", empty: "○", done: "✓" },
    { id: "square", label: "Square", empty: "□", done: "✓" },
    { id: "star", label: "Star", empty: "☆", done: "★" },
    { id: "heart", label: "Heart", empty: "♡", done: "♥" },
    { id: "diamond", label: "Diamond", empty: "◇", done: "◆" },
  ];

  function escAttr(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  function renderEmojiPicker(fieldName, emojis, selected) {
    const pick = selected || emojis[0] || "⭐";
    return `
      <div class="emoji-picker" data-emoji-field="${fieldName}">
        ${emojis
          .map(
            (emoji) =>
              `<button type="button" class="emoji-opt${emoji === pick ? " on" : ""}" data-emoji="${emoji}">${emoji}</button>`
          )
          .join("")}
      </div>
      <input type="hidden" name="${fieldName}" value="${escAttr(pick)}" />`;
  }

  function renderColorPicker(selected) {
    const pick = selected || KID_COLORS[0];
    return `
      <div class="color-picker" data-color-field="color">
        ${KID_COLORS
          .map(
            (color) =>
              `<button type="button" class="color-opt${color === pick ? " on" : ""}" data-color="${color}" style="background:${color}" aria-label="Color ${color}"></button>`
          )
          .join("")}
      </div>
      <input type="hidden" name="color" value="${escAttr(pick)}" />`;
  }

  function renderCheckStylePicker(selected) {
    const pick = selected || "circle";
    return `
      <div class="check-style-picker" data-check-field="checkStyle">
        ${CHECK_STYLES.map(
          (style) => `
          <button type="button" class="check-style-opt${style.id === pick ? " on" : ""}" data-check-style="${style.id}">
            <span class="check-style-preview">${style.empty}</span>
            <span>${style.label}</span>
          </button>`
        ).join("")}
      </div>
      <input type="hidden" name="checkStyle" value="${escAttr(pick)}" />`;
  }

  function setEmojiPicker(form, fieldName, value) {
    const picker = form.querySelector(`.emoji-picker[data-emoji-field="${fieldName}"]`);
    const input = form.querySelector(`[name="${fieldName}"]`);
    if (!picker || !input) return;
    input.value = value || input.value;
    picker.querySelectorAll(".emoji-opt").forEach((btn) => {
      btn.classList.toggle("on", btn.dataset.emoji === input.value);
    });
  }

  function setColorPicker(form, value) {
    const picker = form.querySelector(".color-picker");
    const input = form.querySelector('[name="color"]');
    if (!picker || !input) return;
    input.value = value || input.value;
    picker.querySelectorAll(".color-opt").forEach((btn) => {
      btn.classList.toggle("on", btn.dataset.color === input.value);
    });
  }

  function setCheckStylePicker(form, value) {
    const picker = form.querySelector(".check-style-picker");
    const input = form.querySelector('[name="checkStyle"]');
    if (!picker || !input) return;
    input.value = value || "circle";
    picker.querySelectorAll(".check-style-opt").forEach((btn) => {
      btn.classList.toggle("on", btn.dataset.checkStyle === input.value);
    });
  }

  function wireEmojiPickers(scope = document) {
    scope.querySelectorAll(".emoji-picker").forEach((picker) => {
      if (picker.dataset.wired) return;
      picker.dataset.wired = "1";
      const field = picker.dataset.emojiField;
      picker.querySelectorAll(".emoji-opt").forEach((btn) => {
        btn.addEventListener("click", () => {
          picker.querySelectorAll(".emoji-opt").forEach((b) => b.classList.remove("on"));
          btn.classList.add("on");
          const input = picker.parentElement.querySelector(`[name="${field}"]`);
          if (input) input.value = btn.dataset.emoji;
        });
      });
    });
  }

  function wireColorPickers(scope = document) {
    scope.querySelectorAll(".color-picker").forEach((picker) => {
      if (picker.dataset.wired) return;
      picker.dataset.wired = "1";
      picker.querySelectorAll(".color-opt").forEach((btn) => {
        btn.addEventListener("click", () => {
          picker.querySelectorAll(".color-opt").forEach((b) => b.classList.remove("on"));
          btn.classList.add("on");
          const input = picker.parentElement.querySelector('[name="color"]');
          if (input) input.value = btn.dataset.color;
        });
      });
    });
  }

  function wireCheckStylePickers(scope = document) {
    scope.querySelectorAll(".check-style-picker").forEach((picker) => {
      if (picker.dataset.wired) return;
      picker.dataset.wired = "1";
      picker.querySelectorAll(".check-style-opt").forEach((btn) => {
        btn.addEventListener("click", () => {
          picker.querySelectorAll(".check-style-opt").forEach((b) => b.classList.remove("on"));
          btn.classList.add("on");
          const input = picker.parentElement.querySelector('[name="checkStyle"]');
          if (input) input.value = btn.dataset.checkStyle;
        });
      });
    });
  }

  function resetKidForm() {
    const form = $("#kidForm");
    if (!form) return;
    form.reset();
    const idInput = form.querySelector('[name="id"]');
    if (idInput) idInput.value = "";
    setEmojiPicker(form, "emoji", KID_EMOJIS[0]);
    setColorPicker(form, KID_COLORS[0]);
    const heading = form.closest(".card")?.querySelector("h2");
    if (heading) heading.textContent = "Add kid";
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.textContent = "Save kid";
    $("#cancelKidEdit")?.classList.add("hidden");
  }

  function populateKidForm(kid) {
    const form = $("#kidForm");
    if (!form || !kid) return;
    let idInput = form.querySelector('[name="id"]');
    if (!idInput) {
      idInput = document.createElement("input");
      idInput.type = "hidden";
      idInput.name = "id";
      form.prepend(idInput);
    }
    idInput.value = kid.id;
    form.querySelector('[name="name"]').value = kid.name || "";
    setEmojiPicker(form, "emoji", kid.emoji || KID_EMOJIS[0]);
    setColorPicker(form, kid.color || KID_COLORS[0]);
    const heading = form.closest(".card")?.querySelector("h2");
    if (heading) heading.textContent = "Edit kid";
    form.querySelector('button[type="submit"]').textContent = "Update kid";
    $("#cancelKidEdit")?.classList.remove("hidden");
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function resetChoreForm() {
    const form = $("#choreForm");
    if (!form) return;
    form.reset();
    const idInput = form.querySelector('[name="id"]');
    if (idInput) idInput.value = "";
    setEmojiPicker(form, "icon", "✅");
    setCheckStylePicker(form, "circle");
    form.querySelectorAll("[data-kid-chip]").forEach((chip) => chip.classList.remove("on"));
    form.querySelector("[data-kid-all]")?.classList.remove("on");
    choreForm?.querySelector("[data-kid-all]")?.classList.remove("on");
    const heading = form.closest(".card")?.querySelector("h2");
    if (heading) heading.textContent = "Add chore";
    form.querySelector('button[type="submit"]').textContent = "Save chore";
    $("#cancelChoreEdit")?.classList.add("hidden");
  }

  function populateChoreForm(chore) {
    const form = $("#choreForm");
    if (!form || !chore) return;
    let idInput = form.querySelector('[name="id"]');
    if (!idInput) {
      idInput = document.createElement("input");
      idInput.type = "hidden";
      idInput.name = "id";
      form.prepend(idInput);
    }
    idInput.value = chore.id;
    form.querySelector('[name="title"]').value = chore.title || "";
    form.querySelector('[name="stars"]').value = chore.stars || 1;
    form.querySelector('[name="period"]').value = chore.period || "chore";
    const hintInput = form.querySelector('[name="hint"]');
    if (hintInput) hintInput.value = chore.hint || "";
    setEmojiPicker(form, "icon", chore.icon || "✅");
    setCheckStylePicker(form, chore.checkStyle || "circle");
    const kidIds = new Set(chore.kidIds || []);
    form.querySelectorAll("[data-kid-chip]").forEach((chip) => {
      chip.classList.toggle("on", kidIds.has(chip.dataset.kidChip));
    });
    syncAllKidChip(form);
    const heading = form.closest(".card")?.querySelector("h2");
    if (heading) heading.textContent = "Edit chore";
    form.querySelector('button[type="submit"]').textContent = "Update chore";
    $("#cancelChoreEdit")?.classList.remove("hidden");
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function render() {
    const d = state.data;
    if (!d) return;
    renderServerBanner();
    $("#familyMeta").textContent = `${d.kids.filter((k) => k.active !== false).length} kids · ${d.today}`;
    renderTab();
  }

  function normalizeTab(tab) {
    if (tab === "cons") return "consequences";
    return tab || "lists";
  }

  function renderTab() {
    state.tab = normalizeTab(state.tab);
    $$(".nav [data-tab]").forEach((b) => {
      b.classList.toggle("active", normalizeTab(b.dataset.tab) === state.tab);
    });
    const root = $("#tabContent");
    const d = state.data;
    if (!root) return;
    if (!d) {
      root.innerHTML = `<p class="muted">Loading…</p>`;
      return;
    }
    try {
      const views = {
        kids: renderKids,
        chores: renderChores,
        consequences: renderConsequences,
        lists: renderLists,
        rewards: renderRewards,
        more: renderMore,
      };
      const view = views[state.tab] || views.lists;
      root.innerHTML = view(d);
      wireTabActions();
      syncThemeButtons();
      window.TouchInput?.markTextFields?.(root);
    } catch (err) {
      console.error(err);
      root.innerHTML = `<section class="card"><p class="muted">Couldn't open this tab. Refresh and try again.</p></section>`;
      toast("Couldn't open that tab");
    }
  }

  function renderKids(d) {
    return `
      <section class="card">
        <h2>Add kid</h2>
        <form id="kidForm">
          <input type="hidden" name="id" value="" />
          <div class="field"><label>Name</label><input type="text" inputmode="text" name="name" required placeholder="Maya" /></div>
          <div class="field">
            <label>Emoji</label>
            ${renderEmojiPicker("emoji", KID_EMOJIS, "🐻")}
          </div>
          <div class="field">
            <label>Color</label>
            ${renderColorPicker(KID_COLORS[0])}
          </div>
          <div class="form-actions">
            <button class="btn block" type="submit">Save kid</button>
            <button class="btn ghost block hidden" type="button" id="cancelKidEdit">Cancel edit</button>
          </div>
        </form>
      </section>
      <section class="list">
        ${d.kids
          .map(
            (k) => `
          <article class="item" data-kid="${k.id}">
            <div class="item-head">
              <div class="item-main">
                <div class="title">${k.emoji} ${k.name}</div>
                <div class="muted">★ ${d.balances[k.id] || 0} · <span class="kid-color-dot" style="background:${k.color || "#5aa7ff"}"></span></div>
              </div>
              <button type="button" class="btn-x" data-del-kid="${k.id}" aria-label="Remove ${k.name}">×</button>
            </div>
            <div class="actions">
              <button class="btn secondary compact" data-stars="${k.id}" data-delta="1">+1★</button>
              <button class="btn secondary compact" data-stars="${k.id}" data-delta="-1">−1★</button>
              <button class="btn ghost compact" type="button" data-edit-kid-id="${k.id}">Edit</button>
            </div>
          </article>`
          )
          .join("")}
      </section>`;
  }

  function activeAdminKids() {
    return (state.data?.kids || []).filter((k) => k.active !== false);
  }

  function syncAllKidChip(form) {
    const allBtn = form?.querySelector("[data-kid-all]");
    if (!allBtn) return;
    const chips = [...form.querySelectorAll("[data-kid-chip]")];
    const allOn = chips.length > 0 && chips.every((chip) => chip.classList.contains("on"));
    allBtn.classList.toggle("on", allOn);
  }

  function setAllKidChips(form, on) {
    form.querySelectorAll("[data-kid-chip]").forEach((chip) => chip.classList.toggle("on", on));
    form.querySelector("[data-kid-all]")?.classList.toggle("on", on);
  }

  function selectedKidIds(form) {
    return [...form.querySelectorAll("[data-kid-chip].on")].map((chip) => chip.dataset.kidChip);
  }

  function renderChores(d) {
    const checkStyleLabel = (id) => CHECK_STYLES.find((s) => s.id === id)?.label || "Circle";
    return `
      <section class="card">
        <h2>Add chore</h2>
        <form id="choreForm">
          <input type="hidden" name="id" value="" />
          <div class="field"><label>Title</label><input type="text" inputmode="text" name="title" required placeholder="Make bed" /></div>
          <div class="field">
            <label>Emoji</label>
            ${renderEmojiPicker("icon", CHORE_EMOJIS, "✅")}
          </div>
          <div class="field"><label>Stars</label><input name="stars" type="number" min="1" max="99" value="1" /></div>
          <div class="field"><label>Hint (optional)</label><input type="text" inputmode="text" name="hint" placeholder="Before school — pull covers neat" /></div>
          <div class="field"><label>Period</label>
            <select name="period">
              <option value="chore">Anytime today</option>
              <option value="morning">Morning</option>
              <option value="afternoon">Afternoon</option>
              <option value="evening">Evening</option>
            </select>
          </div>
          <div class="field">
            <label>Checkbox style</label>
            ${renderCheckStylePicker("circle")}
          </div>
          <div class="field"><label>Assign to</label>
            <div class="chips" id="choreKids">
              <button type="button" class="chip chip-all" data-kid-all>All kids</button>
              ${d.kids
                .filter((k) => k.active !== false)
                .map(
                  (k) =>
                    `<button type="button" class="chip" data-kid-chip="${k.id}">${k.emoji} ${k.name}</button>`
                )
                .join("")}
            </div>
          </div>
          <div class="form-actions">
            <button class="btn block" type="submit">Save chore</button>
            <button class="btn ghost block hidden" type="button" id="cancelChoreEdit">Cancel edit</button>
          </div>
        </form>
      </section>
      <section class="list">
        ${d.chores
          .filter((c) => c.active !== false)
          .map((c) => {
            const kids = (c.kidIds || []).map(kidName).join(", ") || "Unassigned";
            return `<article class="item">
              <div class="item-head">
                <div class="item-main">
                  <div class="title">${c.icon || "✅"} ${c.title}</div>
                  <div class="muted">★${c.stars || 1} · ${c.period || "chore"} · ${checkStyleLabel(c.checkStyle)} · ${kids}</div>
                </div>
                <button type="button" class="btn-x" data-del-chore="${c.id}" aria-label="Remove ${c.title}">×</button>
              </div>
              <div class="actions">
                <button class="btn ghost compact" type="button" data-edit-chore-id="${c.id}">Edit</button>
              </div>
            </article>`;
          })
          .join("")}
      </section>`;
  }

  function resetConsequenceForm() {
    const form = $("#consForm");
    if (!form) return;
    form.reset();
    const idInput = form.querySelector('[name="id"]');
    if (idInput) idInput.value = "";
    setEmojiPicker(form, "icon", "⚠️");
    form.querySelectorAll("[data-kid-chip]").forEach((chip) => chip.classList.remove("on"));
    form.querySelector("[data-kid-all]")?.classList.remove("on");
    const heading = form.closest(".card")?.querySelector("h2");
    if (heading) heading.textContent = "Add consequence";
    form.querySelector('button[type="submit"]').textContent = "Save consequence";
    $("#cancelConsEdit")?.classList.add("hidden");
  }

  function populateConsequenceForm(item) {
    const form = $("#consForm");
    if (!form || !item) return;
    let idInput = form.querySelector('[name="id"]');
    if (!idInput) {
      idInput = document.createElement("input");
      idInput.type = "hidden";
      idInput.name = "id";
      form.prepend(idInput);
    }
    idInput.value = item.id;
    form.querySelector('[name="title"]').value = item.title || "";
    form.querySelector('[name="stars"]').value = item.stars || 1;
    const hintInput = form.querySelector('[name="hint"]');
    if (hintInput) hintInput.value = item.hint || "";
    setEmojiPicker(form, "icon", item.icon || "⚠️");
    const kidIds = new Set(item.kidIds || []);
    form.querySelectorAll("[data-kid-chip]").forEach((chip) => {
      chip.classList.toggle("on", kidIds.has(chip.dataset.kidChip));
    });
    syncAllKidChip(form);
    const heading = form.closest(".card")?.querySelector("h2");
    if (heading) heading.textContent = "Edit consequence";
    form.querySelector('button[type="submit"]').textContent = "Update consequence";
    $("#cancelConsEdit")?.classList.remove("hidden");
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderConsequences(d) {
    return `
      <section class="card">
        <h2>Add consequence</h2>
        <p class="muted">Give this to assigned kids to deduct stars. The deduction stays; it only shows on their chore list for 24 hours.</p>
        <form id="consForm">
          <input type="hidden" name="id" value="" />
          <div class="field"><label>Title</label><input type="text" inputmode="text" name="title" required placeholder="Screen time lost" /></div>
          <div class="field">
            <label>Emoji</label>
            ${renderEmojiPicker("icon", CONSEQUENCE_EMOJIS, "⚠️")}
          </div>
          <div class="field"><label>Stars to deduct</label><input name="stars" type="number" min="1" max="99" value="1" /></div>
          <div class="field"><label>Hint (optional)</label><input type="text" inputmode="text" name="hint" placeholder="Why this was given" /></div>
          <div class="field"><label>Assign to</label>
            <div class="chips" id="consKids">
              <button type="button" class="chip chip-all" data-kid-all>All kids</button>
              ${(d.kids || [])
                .filter((k) => k.active !== false)
                .map(
                  (k) =>
                    `<button type="button" class="chip" data-kid-chip="${k.id}">${k.emoji} ${k.name}</button>`
                )
                .join("")}
            </div>
          </div>
          <div class="form-actions">
            <button class="btn block" type="submit">Save consequence</button>
            <button class="btn ghost block hidden" type="button" id="cancelConsEdit">Cancel edit</button>
          </div>
        </form>
      </section>
      <section class="list">
        ${(d.consequences || [])
          .filter((c) => c.active !== false)
          .map((c) => {
            const kids = (c.kidIds || []).map(kidName).join(", ") || "Unassigned";
            return `<article class="item">
              <div class="item-head">
                <div class="item-main">
                  <div class="title">${c.icon || "⚠️"} ${c.title}</div>
                  <div class="muted">−★${c.stars || 1} · ${kids}</div>
                </div>
                <button type="button" class="btn-x" data-del-cons="${c.id}" aria-label="Remove ${c.title}">×</button>
              </div>
              <div class="actions">
                <button class="btn secondary compact" type="button" data-apply-cons="${c.id}">Give now</button>
                <button class="btn ghost compact" type="button" data-edit-cons-id="${c.id}">Edit</button>
              </div>
            </article>`;
          })
          .join("") || `<p class="muted">No consequences yet.</p>`}
      </section>`;
  }

  function formatCompletedAt(ms) {
    const t = Number(ms);
    if (!t) return "Completed";
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return "Completed";
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return `Today · ${time}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday · ${time}`;
    return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} · ${time}`;
  }

  function renderLists(d) {
    const folders = [
      { id: "grocery", title: "Groceries", placeholder: "Add grocery" },
      { id: "reminders", title: "Reminders", placeholder: "Add reminder" },
    ];
    const name = folders.some((f) => f.id === state.listFolder) ? state.listFolder : "grocery";
    const folder = folders.find((f) => f.id === name);
    const items = d.lists?.[name] || [];
    const open = items.filter((item) => !item.done);
    const done = items
      .filter((item) => item.done)
      .slice()
      .sort((a, b) => Number(b.completedAt || 0) - Number(a.completedAt || 0));
    const tabs = folders
      .map((f) => {
        const count = (d.lists?.[f.id] || []).filter((item) => !item.done).length;
        return `
          <button type="button" class="folder-tab${f.id === name ? " active" : ""}" data-list-folder="${f.id}">
            ${f.title}${count ? ` <span class="folder-count">${count}</span>` : ""}
          </button>`;
      })
      .join("");
    const openRows =
      open
        .map(
          (item) => `
        <button class="item" data-list-toggle="${name}" data-id="${item.id}" type="button">
          <div class="row">
            <div class="title">⬜️ ${item.text}</div>
            <span class="muted" style="flex-shrink:0">Tap to complete</span>
          </div>
        </button>`
        )
        .join("") || `<p class="muted">No items — add above</p>`;
    const doneRows = done
      .map(
        (item) => `
        <button class="item item-done" data-list-toggle="${name}" data-id="${item.id}" type="button">
          <div class="row">
            <div>
              <div class="title">✅ ${item.text}</div>
              <div class="muted">${formatCompletedAt(item.completedAt)}</div>
            </div>
            <span class="muted" style="flex-shrink:0">Tap to restore</span>
          </div>
        </button>`
      )
      .join("");
    return `
      <div class="folder">
        <div class="folder-tabs" role="tablist">${tabs}</div>
        <section class="folder-panel">
          <form data-list-add="${name}" class="row" style="margin-bottom:0.65rem">
            <input type="text" inputmode="text" name="text" placeholder="${folder.placeholder}" required class="list-add-input" />
            <button class="btn" type="submit">Add</button>
          </form>
          <div class="list">${openRows}</div>
          <div class="completed-box">
            <button type="button" class="completed-toggle" data-completed-toggle>
              <span>Completed${done.length ? ` (${done.length})` : ""}</span>
              <span class="completed-caret">${state.listCompletedOpen ? "▾" : "▸"}</span>
            </button>
            <div class="completed-panel${state.listCompletedOpen ? "" : " hidden"}">
              ${
                done.length
                  ? `<div class="list">${doneRows}</div>
                     <button type="button" class="btn ghost block" data-clear-completed="${name}">Clear completed</button>`
                  : `<p class="muted">Nothing completed yet</p>`
              }
            </div>
          </div>
        </section>
      </div>`;
  }

  function renderRewards(d) {
    return `
      <section class="card">
        <h2>Add reward</h2>
        <form id="rewardForm">
          <div class="field"><label>Title</label><input type="text" inputmode="text" name="title" required placeholder="Pick dessert" /></div>
          <div class="field"><label>Emoji</label><input type="text" inputmode="text" name="icon" value="🎁" maxlength="4" /></div>
          <div class="field"><label>Star cost</label><input name="cost" type="number" min="1" value="10" /></div>
          <button class="btn block" type="submit">Save reward</button>
        </form>
      </section>
      <section class="list">
        ${d.rewards
          .filter((r) => r.active !== false)
          .map(
            (r) => `
          <article class="item">
            <div class="title">${r.icon || "🎁"} ${r.title}</div>
            <div class="muted">★ ${r.cost}</div>
          </article>`
          )
          .join("")}
      </section>`;
  }

  function sourceTypeLabel(type) {
    const map = { google: "Google Photos", icloud: "iCloud", urls: "URLs", builtin: "Built-in" };
    return map[type] || type;
  }

  function allAlbumIds(sources, uploads) {
    const ids = ["nature"];
    sources.forEach((s) => ids.push(s.id));
    if (uploads.length) ids.push("uploads");
    return ids;
  }

  function albumIsChecked(id, activeIds) {
    if (!Array.isArray(activeIds)) return true;
    return activeIds.includes(id);
  }

  function kioskScreenList() {
    return (window.FAMILY_SCREENS?.screens || []).filter((s) => s.enabled !== false);
  }

  function renderRotationRows(rotation) {
    const rotScreens = rotation?.screens || {};
    return kioskScreenList()
      .map((s) => {
        const cfg = rotScreens[s.id] || { enabled: true, seconds: 45 };
        return `
          <div class="rotation-row">
            <label class="rotation-toggle">
              <input type="checkbox" name="rot_${s.id}" ${cfg.enabled !== false ? "checked" : ""} />
              <span>${s.icon} ${s.title}</span>
            </label>
            <label class="rotation-seconds">
              <input type="number" name="seconds_${s.id}" min="5" max="600" value="${cfg.seconds ?? 45}" aria-label="Seconds on ${s.title}" />
              <span>sec</span>
            </label>
          </div>`;
      })
      .join("");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderFileButtons() {
    const files = state.adminFiles || [];
    const shortcuts = files.length
      ? files
          .map(
            (f) => `
      <button type="button" class="btn secondary block file-open-btn${f.id === state.adminFileId ? " active" : ""}" data-open-file="${f.id}">
        ${escapeHtml(f.label)}
        <span class="muted">${f.exists ? escapeHtml(f.rel) : "not created yet"}</span>
      </button>`
          )
          .join("")
      : `<p class="muted">Loading shortcuts…</p>`;
    return `${shortcuts}${renderBrowseList()}`;
  }

  function renderBrowseList() {
    const listing = state.browseListing;
    if (!listing) return `<p class="muted" style="margin-top:0.75rem">Opening family-board-src…</p>`;
    const pathLabel = listing.path ? `family-board-src / ${listing.path.replaceAll("/", " / ")}` : "family-board-src";
    const up = listing.parent != null
      ? `<button type="button" class="btn ghost block" data-browse-path="${escapeHtml(listing.parent)}">Up one folder</button>`
      : "";
    const entries = (listing.entries || [])
      .map((entry) => {
        if (entry.type === "dir") {
          return `<button type="button" class="btn secondary block file-open-btn" data-browse-path="${escapeHtml(entry.path)}">📁 ${escapeHtml(entry.name)}</button>`;
        }
        const canOpen = entry.text !== false;
        return `<button type="button" class="btn secondary block file-open-btn${state.adminFile?.path === entry.path ? " active" : ""}" data-open-browse="${escapeHtml(entry.path)}" ${canOpen ? "" : "disabled"}>
          ${escapeHtml(entry.name)}
          <span class="muted">${canOpen ? "text file" : "not editable"}</span>
        </button>`;
      })
      .join("");
    return `
      <div class="file-browser">
        <h3>family-board-src</h3>
        <p class="file-crumb muted">${escapeHtml(pathLabel)}</p>
        ${up}
        <div class="file-list">${entries || `<p class="muted">This folder is empty.</p>`}</div>
      </div>`;
  }

  function renderFileEditor() {
    const open = state.adminFile;
    if (!open) return "";
    return `
      <form id="adminFileForm" class="file-editor-form">
        <h3>${escapeHtml(open.label)}</h3>
        <p class="muted">${escapeHtml(open.hint || open.path || "")}</p>
        <textarea id="adminFileText" class="file-editor" spellcheck="false" ${open.writable ? "" : "readonly"}>${escapeHtml(open.content)}</textarea>
        <div class="file-editor-actions">
          <button type="button" class="btn secondary block" id="copyFileBtn">Copy all</button>
          ${open.writable ? `<button type="submit" class="btn block">Save file</button>` : ""}
          <button type="button" class="btn ghost block" id="closeFileBtn">Back to folder</button>
        </div>
      </form>`;
  }

  function bindFileOpenButtons() {
    $$("[data-open-file]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.openFile;
        try {
          state.adminFile = await AdminAPI.getFile(state.token, id, state.filesToken);
          state.adminFileId = id;
          renderTab();
        } catch (err) {
          toast(apiErrorMessage(err) || "Could not open file");
        }
      });
    });
    $$("[data-browse-path]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.adminFile = null;
        state.adminFileId = "";
        loadBrowse(btn.dataset.browsePath || "");
      });
    });
    $$("[data-open-browse]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const filePath = btn.dataset.openBrowse;
        try {
          state.adminFile = await AdminAPI.readBrowseFile(state.token, filePath, state.filesToken);
          state.adminFileId = "";
          renderTab();
        } catch (err) {
          toast(apiErrorMessage(err) || "Could not open file");
        }
      });
    });
  }

  async function loadBrowse(path) {
    const host = $("#adminFileList");
    if (!host) return;
    try {
      const data = await AdminAPI.browse(state.token, path ?? state.browsePath, state.filesToken);
      state.browsePath = data.path || "";
      state.browseListing = data;
      host.innerHTML = renderFileButtons();
      bindFileOpenButtons();
    } catch (err) {
      host.innerHTML = `<p class="muted">${escapeHtml(apiErrorMessage(err) || "Could not open folder")}</p>`;
    }
  }

  function lockFiles() {
    state.filesUnlocked = false;
    state.filesToken = "";
    state.adminFiles = [];
    state.adminFile = null;
    state.adminFileId = "";
    state.browseListing = null;
    try {
      sessionStorage.removeItem(FILES_TOKEN_KEY);
    } catch {}
  }

  async function loadAdminFiles() {
    if (!state.filesToken) {
      lockFiles();
      return;
    }
    try {
      const data = await AdminAPI.listFiles(state.token, state.filesToken);
      state.adminFiles = data.files || [];
      state.filesUnlocked = true;
    } catch (err) {
      if (String(err.message || "").includes("locked") || String(err.message || "").includes("403")) {
        lockFiles();
        renderTab();
        return;
      }
      state.adminFiles = [];
    }
    if (!$("#adminFileList")) {
      renderTab();
      return;
    }
    await loadBrowse(state.browsePath);
  }

  function renderMore(d) {
    const nm = {
      enabled: false,
      dimTime: "22:00",
      brightTime: "06:00",
      brightness: 15,
      ...(d.settings?.nightMode || {}),
    };
    const rawSs = d.settings?.screensaver || {};
    const ss = {
      enabled: false,
      idleMinutes: 5,
      slideSeconds: 12,
      scheduleEnabled: false,
      startTime: "22:00",
      endTime: "06:00",
      sources: [],
      ...rawSs,
    };
    const uploads = d.screensaverPhotos || [];
    const sources = ss.sources || [];
    const rot = {
      pauseOnTouchSeconds: 120,
      screens: {},
      ...(d.settings?.rotation || {}),
    };
    const activeIds = Object.prototype.hasOwnProperty.call(rawSs, "activeAlbumIds")
      ? rawSs.activeAlbumIds
      : null;
    const albumPicker = (id, label, meta) => `
      <label class="ss-album-pick">
        <input type="checkbox" name="activeAlbum" value="${id}" ${albumIsChecked(id, activeIds) ? "checked" : ""} />
        <span class="ss-album-pick-text">
          <strong>${label}</strong>
          ${meta ? `<span class="muted">${meta}</span>` : ""}
        </span>
      </label>`;
    return `
      <section class="card">
        <div class="row night-head">
          <h2>Appearance</h2>
        </div>
        <div class="theme-block">
          <div>
            <strong>Admin</strong>
            <p class="muted night-hint">This phone. Saved on this device.</p>
          </div>
          <div class="theme-switch" role="group" aria-label="Admin appearance">
            <button type="button" data-theme-set="day"><span class="ico" aria-hidden="true">☀</span> Day</button>
            <button type="button" data-theme-set="night"><span class="ico" aria-hidden="true">☾</span> Night</button>
          </div>
        </div>
        <div class="theme-block">
          <div>
            <strong>Kiosk</strong>
            <p class="muted night-hint">TV / Pi display. Updates live.</p>
          </div>
          <div class="theme-switch" role="group" aria-label="Kiosk appearance">
            <button type="button" data-kiosk-theme-set="day"><span class="ico" aria-hidden="true">☀</span> Day</button>
            <button type="button" data-kiosk-theme-set="night"><span class="ico" aria-hidden="true">☾</span> Night</button>
          </div>
        </div>
      </section>
      <section class="card ss-card">
        <form id="screensaverForm">
          <div class="row night-head">
            <h2>Photo screensaver</h2>
            <label class="night-toggle">
              <input type="checkbox" name="enabled" ${ss.enabled ? "checked" : ""} />
              <span>On</span>
            </label>
          </div>
          <p class="muted night-hint">Set idle minutes (1+), or enable schedule. Tap TV to dismiss.</p>
          <div class="ss-grid">
            <label>
              Idle (min)
              <input type="number" name="idleMinutes" min="1" max="180" value="${Math.max(1, ss.idleMinutes || 5)}" />
            </label>
            <label>
              Slide (sec)
              <input type="number" name="slideSeconds" min="4" max="120" value="${ss.slideSeconds}" />
            </label>
          </div>
          <label class="night-toggle ss-schedule-toggle">
            <input type="checkbox" name="scheduleEnabled" ${ss.scheduleEnabled ? "checked" : ""} />
            <span>Also run on a schedule</span>
          </label>
          <div class="night-times">
            <label>
              From
              <input type="time" name="startTime" value="${ss.startTime}" />
            </label>
            <label>
              To
              <input type="time" name="endTime" value="${ss.endTime}" />
            </label>
          </div>
          <div class="ss-show-picker">
            <h3>Show on TV</h3>
            <p class="muted">Pick which albums rotate on the display.</p>
            <div class="ss-album-picks">
              ${albumPicker("nature", "🌲 Nature", "Built-in landscapes")}
              ${sources
                .map((s) => albumPicker(s.id, s.label || "Album", sourceTypeLabel(s.type)))
                .join("")}
              ${uploads.length ? albumPicker("uploads", "📷 Uploaded photos", `${uploads.length} photo${uploads.length === 1 ? "" : "s"}`) : ""}
            </div>
          </div>
          <button class="btn block" type="submit">Save screensaver</button>
        </form>
        <div class="ss-sources">
          <h3>Photo albums</h3>
          <p class="muted">Add shared album links from Google Photos, iCloud, or direct URLs.</p>
          ${sources.length ? `<ul class="ss-source-list">${sources
            .map(
              (s) => `
            <li class="ss-source-item">
              <div class="ss-source-text">
                <strong>${s.label || "Album"}</strong>
                <span class="muted">${sourceTypeLabel(s.type)}</span>
              </div>
              <button type="button" class="btn-x" data-del-source="${s.id}" aria-label="Remove album">×</button>
            </li>`
            )
            .join("")}</ul>` : `<p class="muted">No albums linked yet.</p>`}
          <form id="addSourceForm" class="ss-add-form">
            <div class="field">
              <label>Type</label>
              <select name="type">
                <option value="google">Google Photos (shared link)</option>
                <option value="icloud">iCloud (shared album)</option>
                <option value="urls">Direct image URLs</option>
              </select>
            </div>
            <div class="field">
              <label>Label</label>
              <input type="text" inputmode="text" name="label" placeholder="Family trip" required />
            </div>
            <div class="field">
              <label>Link or URLs</label>
              <textarea name="url" rows="3" inputmode="text" placeholder="https://photos.app.goo.gl/..." required></textarea>
            </div>
            <button class="btn secondary block" type="submit">Add album</button>
          </form>
        </div>
        <div class="ss-uploads">
          <h3>Uploaded photos</h3>
          ${uploads.length ? `<ul class="ss-source-list">${uploads
            .map(
              (p) => `
            <li class="ss-source-item">
              <span class="ss-source-text ss-filename">${p.label || p.filename}</span>
              <button type="button" class="btn-x" data-del-photo="${p.id}" aria-label="Remove photo">×</button>
            </li>`
            )
            .join("")}</ul>` : `<p class="muted">No uploads yet.</p>`}
          <label class="btn secondary block ss-upload-btn">
            Upload photo
            <input type="file" id="photoUploadInput" accept="image/*" hidden />
          </label>
        </div>
      </section>
      <section class="card night-card">
        <form id="nightModeForm">
          <div class="row night-head">
            <h2>TV night dim</h2>
            <label class="night-toggle">
              <input type="checkbox" name="enabled" ${nm.enabled ? "checked" : ""} />
              <span>On</span>
            </label>
          </div>
          <p class="muted night-hint">Dims the TV overnight. Set dim and wake times, then Save.</p>
          ${nm.enabled ? `<p class="muted night-status">Active · dim ${nm.dimTime} · wake ${nm.brightTime} · ${nm.brightness ?? 15}% bright</p>` : ""}
          <div class="night-times">
            <label>
              Dim
              <input type="time" name="dimTime" value="${nm.dimTime}" required />
            </label>
            <label>
              Wake
              <input type="time" name="brightTime" value="${nm.brightTime}" required />
            </label>
          </div>
          <label class="night-brightness">
            <span class="night-brightness-head">
              <span>Night brightness</span>
              <strong id="brightnessVal">${nm.brightness ?? 15}%</strong>
            </span>
            <input
              type="range"
              name="brightness"
              min="1"
              max="100"
              step="1"
              value="${nm.brightness ?? 15}"
              aria-valuemin="1"
              aria-valuemax="100"
              aria-valuenow="${nm.brightness ?? 15}"
            />
            <span class="muted night-brightness-hint">How bright the TV stays overnight (lower = darker).</span>
          </label>
          <button class="btn block" type="submit">Save</button>
        </form>
      </section>
      <section class="card rotation-card">
        <form id="rotationForm">
          <h2>Screen rotation</h2>
          <p class="muted">Uncheck a screen to skip it in auto-rotation. Nav buttons stay on all screens.</p>
          <div class="rotation-rows">
            ${renderRotationRows(rot)}
          </div>
          <button class="btn block" type="submit">Save rotation</button>
        </form>
      </section>
      <section class="install-banner card" id="installCard">
        <h2>Install on your phone</h2>
        <p class="muted" style="margin-bottom:0.65rem">
          iPhone: Share → Add to Home Screen.<br/>
          Android: Browser menu → Install app / Add to Home screen.
        </p>
        <button class="btn secondary" id="installBtn" ${state.deferredPrompt ? "" : "disabled"}>
          ${state.deferredPrompt ? "Install Family Admin" : "Use browser menu to install"}
        </button>
      </section>
      <section class="card">
        <h2>family-board-src</h2>
        ${
          state.filesUnlocked
            ? `
        <p class="muted">Open the project folder on the Pi. Copy, paste, and save files from here — including when you are away from home.</p>
        <div class="file-list" id="adminFileList">${renderFileButtons()}</div>
        ${renderFileEditor()}
        <button type="button" class="btn ghost block" id="lockFilesBtn" style="margin-top:0.75rem">Lock files</button>`
            : `
        <p class="muted">File access is hidden until you unlock it.</p>
        <form id="filesUnlockForm" class="files-unlock">
          <label class="field">
            <span>Password</span>
            <input type="password" inputmode="text" id="filesUnlockPassword" name="filesPassword" autocomplete="off" />
          </label>
          ${state.filesUnlockError ? `<p class="muted">${escapeHtml(state.filesUnlockError)}</p>` : ""}
          <button type="submit" class="btn block">Unlock files</button>
        </form>`
        }
      </section>
      <section class="card">
        <h2>Display links</h2>
        <p class="muted">Open these on the Pi / TV kiosk. Use mouse links on non-touch monitors.</p>
        <div class="actions link-grid">
          <a class="btn secondary" href="/screens/calendar.html?kiosk=1">Kiosk</a>
          <a class="btn secondary" href="/screens/calendar.html?kiosk=1&mouse=1">Kiosk + mouse</a>
          <a class="btn secondary" href="/screens/chores.html?kiosk=1">Chores</a>
          <a class="btn secondary" href="/screens/rewards.html?kiosk=1">Rewards</a>
        </div>
      </section>
      <section class="card">
        <h2>Server</h2>
        <p class="muted">
          Pull updates also turns on auto-start: API, kiosk, and Cloudflare tunnel
          after every power cycle. Use the LAN admin URL if the public site shows 1033.
        </p>
        <p class="muted" id="deployMeta">Checking deploy status…</p>
        <button class="btn block" type="button" id="deployServerBtn">Pull updates &amp; restart now</button>
        <button class="btn secondary block" type="button" id="startTunnelBtn">Start Cloudflare tunnel</button>
        <button class="btn secondary block" type="button" id="restartServerBtn">Restart only</button>
        <button class="btn danger block" type="button" id="rebootPiBtn" style="margin-top:0.55rem">Reboot Raspberry Pi</button>
        <p class="muted restart-status hidden" id="restartStatus"></p>
      </section>
      <section class="card">
        <h2>Kiosk</h2>
        <a class="btn secondary block" href="/screens/calendar.html?kiosk=1">Back to kiosk</a>
        <a class="btn ghost block" href="/screens/calendar.html?kiosk=1&mouse=1" style="margin-top:0.45rem">Back to kiosk (mouse)</a>
      </section>
      <section class="card">
        <h2>Session</h2>
        <button class="btn danger block" id="logoutBtn">Reload admin</button>
      </section>`;
  }

  async function fillDeployMeta() {
    const el = $("#deployMeta");
    if (!el) return;
    try {
      const health = await AdminAPI.health();
      const git = health?.git || {};
      const d = health?.deploy || {};
      const bits = [];
      if (git.sha) bits.push(`code ${git.sha}${git.branch ? ` @ ${git.branch}` : ""}`);
      bits.push(d.gitRepo ? "git repo ready" : "not a git repo — auto-pull won't work");
      bits.push(d.webhookConfigured ? "webhook secret set" : "no webhook secret yet");
      const last = d.last;
      if (last?.ok === false) bits.push(`last deploy failed: ${last.error || last.pull?.stderr || "unknown"}`);
      else if (last?.pull?.alreadyUpToDate) bits.push("last pull: already up to date");
      const boot = d.boot || {};
      const fmt = (u) => {
        if (!u) return "";
        const on = u.active === "active" ? "running" : u.active || "off";
        const en = u.enabled === "enabled" ? "boot" : "no-boot";
        return `${on}/${en}`;
      };
      if (boot.api) bits.push(`api ${fmt(boot.api)}`);
      if (boot.kiosk) bits.push(`kiosk ${fmt(boot.kiosk)}`);
      if (boot.tunnel) {
        const name = boot.tunnel.unit ? ` ${boot.tunnel.unit}` : "";
        bits.push(`tunnel${name} ${fmt(boot.tunnel)}`);
      }
      el.textContent = bits.join(" · ");
    } catch {
      el.textContent = "Can't reach server health check";
    }
  }

  function deployErrorMessage(result) {
    if (!result) return "Deploy failed";
    const pull = result.pull || {};
    const raw = result.error || pull.error || pull.stderr || pull.stdout || "Deploy failed";
    const msg = String(raw).trim();
    if (msg.includes("already in progress")) {
      return "Deploy already running — wait a few seconds and try again";
    }
    if (msg.includes("local variable 'out'") || msg.includes('local variable "out"')) {
      return "Broken deploy on the Pi — SSH: cd ~/family-board-src && git fetch origin && git reset --hard origin/master && sudo systemctl restart family-board-api";
    }
    if (msg.includes("merge") || msg.includes("overwriting") || msg.includes("local changes")) {
      return "Old deploy on the Pi — SSH: cd ~/family-board-src && bash scripts/git_sync.sh && sudo systemctl restart family-board-api";
    }
    if (msg.includes("Not a git repository")) {
      return "Not a git clone — use git clone on this machine for pull-to-update";
    }
    return msg.length > 160 ? `${msg.slice(0, 157)}…` : msg;
  }

  async function waitForDeployFinish() {
    const start = Date.now();
    const maxMs = 120000;
    while (Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 800));
      try {
        const st = await AdminAPI.deployStatus(state.token);
        if (!st.busy && st.last) return st.last;
      } catch {
        /* server may be restarting */
      }
    }
    return null;
  }

  async function waitForServerRestart(statusEl, btn) {
    const start = Date.now();
    const maxMs = 45000;
    while (Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 1200));
      try {
        const health = await AdminAPI.health();
        if (health?.ok && Number(health.version) >= REQUIRED_API_VERSION) {
          if (statusEl) statusEl.textContent = "Server is back online.";
          toast("Server restarted");
          try {
            await AdminAPI.session(state.token);
            state.serverOk = true;
            state.serverHint = "";
            await refresh();
          } catch {
            logoutSession("Server restarted — log in again");
          }
          if (btn) btn.disabled = false;
          $("#deployServerBtn")?.removeAttribute("disabled");
          if (statusEl) statusEl.classList.add("hidden");
          return true;
        }
      } catch {
        /* still down */
      }
      if (statusEl) statusEl.textContent = "Restarting… waiting for server";
    }
    if (statusEl) {
      statusEl.textContent = "Server didn't come back. Run npm start on the PC.";
    }
    if (btn) btn.disabled = false;
    $("#deployServerBtn")?.removeAttribute("disabled");
    return false;
  }

  function wireTabActions() {
    wireEmojiPickers();
    wireColorPickers();
    wireCheckStylePickers();

    const kidForm = $("#kidForm");
    if (kidForm) {
      kidForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(kidForm);
        const editing = !!fd.get("id");
        try {
          await AdminAPI.saveKid(state.token, {
            id: fd.get("id") || undefined,
            name: fd.get("name"),
            emoji: fd.get("emoji"),
            color: fd.get("color"),
          });
          toast(editing ? "Kid updated" : "Kid saved");
          resetKidForm();
          await refresh();
        } catch (err) {
          toast(apiErrorMessage(err));
        }
      });
    }

    $("#cancelKidEdit")?.addEventListener("click", () => resetKidForm());

    $$("[data-stars]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await AdminAPI.adjustStars(state.token, btn.dataset.stars, Number(btn.dataset.delta));
        toast("Stars updated");
        await refresh();
      });
    });

    $$("[data-edit-kid-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kid = state.data?.kids?.find((k) => k.id === btn.dataset.editKidId);
        if (!kid) return;
        populateKidForm(kid);
        $("#cancelKidEdit")?.classList.remove("hidden");
      });
    });

    $$("[data-del-kid]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.delKid;
        const name = kidName(id);
        if (!confirm(`Remove ${name}? This cannot be undone.`)) return;
        try {
          await AdminAPI.deleteKid(state.token, id);
          toast("Kid removed");
          await refresh();
        } catch (err) {
          toast(apiErrorMessage(err) || "Remove failed");
        }
      });
    });

    $$("[data-del-chore]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.delChore;
        const chore = state.data?.chores?.find((c) => c.id === id);
        const label = chore ? `${chore.icon || "✅"} ${chore.title}` : "this chore";
        if (!confirm(`Remove ${label}?`)) return;
        try {
          await AdminAPI.deleteChore(state.token, id);
          toast("Chore removed");
          await refresh();
        } catch (err) {
          toast(apiErrorMessage(err) || "Remove failed");
        }
      });
    });

    const choreForm = $("#choreForm");
    if (choreForm) {
      const allKidBtn = choreForm.querySelector("[data-kid-all]");
      allKidBtn?.addEventListener("click", () => {
        const turnOn = !allKidBtn.classList.contains("on");
        setAllKidChips(choreForm, turnOn);
      });
      $$("[data-kid-chip]").forEach((chip) => {
        chip.addEventListener("click", () => {
          chip.classList.toggle("on");
          syncAllKidChip(choreForm);
        });
      });
      choreForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(choreForm);
        const editing = !!fd.get("id");
        const kidIds = selectedKidIds(choreForm);
        if (!kidIds.length) {
          toast("Assign at least one kid");
          return;
        }
        try {
          await AdminAPI.saveChore(state.token, {
            id: fd.get("id") || undefined,
            title: fd.get("title"),
            icon: fd.get("icon"),
            stars: Number(fd.get("stars") || 1),
            period: fd.get("period"),
            hint: fd.get("hint") || "",
            checkStyle: fd.get("checkStyle") || "circle",
            kidIds,
            repeat: "daily",
          });
          toast(editing ? "Chore updated" : "Chore saved");
          resetChoreForm();
          await refresh();
        } catch (err) {
          toast(apiErrorMessage(err));
        }
      });
    }

    $("#cancelChoreEdit")?.addEventListener("click", () => resetChoreForm());

    $$("[data-edit-chore-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const chore = state.data?.chores?.find((c) => c.id === btn.dataset.editChoreId);
        if (!chore) return;
        populateChoreForm(chore);
        $("#cancelChoreEdit")?.classList.remove("hidden");
      });
    });

    const consForm = $("#consForm");
    if (consForm) {
      const allKidBtn = consForm.querySelector("[data-kid-all]");
      allKidBtn?.addEventListener("click", () => {
        const turnOn = !allKidBtn.classList.contains("on");
        setAllKidChips(consForm, turnOn);
      });
      consForm.querySelectorAll("[data-kid-chip]").forEach((chip) => {
        chip.addEventListener("click", () => {
          chip.classList.toggle("on");
          syncAllKidChip(consForm);
        });
      });
      consForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(consForm);
        const editing = !!fd.get("id");
        const kidIds = selectedKidIds(consForm);
        if (!kidIds.length) {
          toast("Assign at least one kid");
          return;
        }
        try {
          await AdminAPI.saveConsequence(state.token, {
            id: fd.get("id") || undefined,
            title: fd.get("title"),
            icon: fd.get("icon"),
            stars: Number(fd.get("stars") || 1),
            hint: fd.get("hint") || "",
            kidIds,
          });
          toast(editing ? "Consequence updated" : "Consequence saved");
          resetConsequenceForm();
          await refresh();
        } catch (err) {
          toast(apiErrorMessage(err));
        }
      });
    }

    $("#cancelConsEdit")?.addEventListener("click", () => resetConsequenceForm());

    $$("[data-edit-cons-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = (state.data?.consequences || []).find((c) => c.id === btn.dataset.editConsId);
        if (!item) return;
        populateConsequenceForm(item);
      });
    });

    $$("[data-del-cons]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.delCons;
        const item = (state.data?.consequences || []).find((c) => c.id === id);
        const label = item ? `${item.icon || "⚠️"} ${item.title}` : "this consequence";
        if (!confirm(`Remove ${label}? Past star deductions stay.`)) return;
        try {
          await AdminAPI.deleteConsequence(state.token, id);
          toast("Consequence removed");
          await refresh();
        } catch (err) {
          toast(apiErrorMessage(err) || "Remove failed");
        }
      });
    });

    $$("[data-apply-cons]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.applyCons;
        const item = (state.data?.consequences || []).find((c) => c.id === id);
        if (!item) return;
        const kidIds = (item.kidIds || []).length
          ? item.kidIds
          : (state.data?.kids || []).filter((k) => k.active !== false).map((k) => k.id);
        if (!kidIds.length) {
          toast("Assign at least one kid first");
          return;
        }
        const names = kidIds.map(kidName).join(", ");
        if (!confirm(`Give ${item.icon || "⚠️"} ${item.title} (−★${item.stars || 1}) to ${names}?`)) return;
        try {
          await AdminAPI.applyConsequence(state.token, id, kidIds);
          toast("Consequence given");
          await refresh();
        } catch (err) {
          toast(apiErrorMessage(err) || "Could not apply");
        }
      });
    });

    $$("[data-list-folder]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.listFolder = btn.dataset.listFolder;
        renderTab();
      });
    });

    $("[data-completed-toggle]")?.addEventListener("click", () => {
      state.listCompletedOpen = !state.listCompletedOpen;
      renderTab();
    });

    $("[data-clear-completed]")?.addEventListener("click", async (e) => {
      const name = e.currentTarget.dataset.clearCompleted;
      try {
        await AdminAPI.clearCompletedList(state.token, name);
        toast("Completed items cleared");
        await refresh();
      } catch (err) {
        toast(apiErrorMessage(err));
      }
    });

    $$("[data-list-add]").forEach((form) => {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = form.dataset.listAdd;
        const text = new FormData(form).get("text");
        try {
          const res = await AdminAPI.addListItem(name, text);
          form.reset();
          await refresh();
          if (res.item && window.ListUndo) {
            ListUndo.offer(`Added "${text}"`, async () => {
              await AdminAPI.deleteListItem(state.token, name, res.item.id);
              await refresh();
            });
          } else {
            toast("Item added");
          }
        } catch (err) {
          toast(apiErrorMessage(err));
        }
      });
    });

    $$("[data-list-toggle]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const name = btn.dataset.listToggle;
          const res = await AdminAPI.toggleListItem(state.token, name, btn.dataset.id);
          if (res.completed) state.listCompletedOpen = true;
          await refresh();
          if (res.item && window.ListUndo) {
            const label = res.completed ? `Completed "${res.item.text}"` : `Restored "${res.item.text}"`;
            ListUndo.offer(label, async () => {
              await AdminAPI.toggleListItem(state.token, name, res.item.id);
              await refresh();
            });
          }
        } catch (err) {
          toast(apiErrorMessage(err));
        }
      });
    });

    const rewardForm = $("#rewardForm");
    if (rewardForm) {
      rewardForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(rewardForm);
        await AdminAPI.saveReward(state.token, {
          title: fd.get("title"),
          icon: fd.get("icon"),
          cost: Number(fd.get("cost") || 10),
        });
        toast("Reward saved");
        await refresh();
      });
    }

    const installBtn = $("#installBtn");
    if (installBtn && state.deferredPrompt) {
      installBtn.addEventListener("click", async () => {
        state.deferredPrompt.prompt();
        await state.deferredPrompt.userChoice;
        state.deferredPrompt = null;
        toast("Install prompted");
        renderTab();
      });
    }

    const nightModeForm = $("#nightModeForm");
    if (nightModeForm) {
      const brightnessInput = nightModeForm.querySelector('[name="brightness"]');
      const brightnessVal = $("#brightnessVal");
      if (brightnessInput && brightnessVal) {
        brightnessInput.addEventListener("input", () => {
          brightnessVal.textContent = `${brightnessInput.value}%`;
          brightnessInput.setAttribute("aria-valuenow", brightnessInput.value);
        });
      }
      nightModeForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(nightModeForm);
        const btn = nightModeForm.querySelector('button[type="submit"]');
        try {
          if (btn) btn.disabled = true;
          await AdminAPI.saveSettings(state.token, {
            nightMode: {
              enabled: fd.has("enabled"),
              dimTime: fd.get("dimTime"),
              brightTime: fd.get("brightTime"),
              brightness: Number(fd.get("brightness") || 15),
            },
          });
          toast("Saved");
          await refresh();
        } catch (err) {
          toast(apiErrorMessage(err));
        } finally {
          if (btn) btn.disabled = false;
        }
      });
    }

    const rotationForm = $("#rotationForm");
    if (rotationForm) {
      rotationForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(rotationForm);
        const btn = rotationForm.querySelector('button[type="submit"]');
        const screens = {};
        kioskScreenList().forEach((s) => {
          screens[s.id] = {
            enabled: fd.has(`rot_${s.id}`),
            seconds: Math.max(5, Math.min(600, Number(fd.get(`seconds_${s.id}`) || 45))),
          };
        });
        try {
          if (btn) btn.disabled = true;
          await AdminAPI.saveSettings(state.token, {
            rotation: { screens },
          });
          toast("Rotation saved");
          await refresh();
        } catch (err) {
          toast(apiErrorMessage(err));
        } finally {
          if (btn) btn.disabled = false;
        }
      });
    }

    const screensaverForm = $("#screensaverForm");
    if (screensaverForm) {
      screensaverForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(screensaverForm);
        const btn = screensaverForm.querySelector('button[type="submit"]');
        const current = state.data?.settings?.screensaver || {};
        const activeAlbumIds = [...screensaverForm.querySelectorAll('input[name="activeAlbum"]:checked')].map(
          (el) => el.value
        );
        if (fd.has("enabled") && !activeAlbumIds.length) {
          toast("Pick at least one album");
          return;
        }
        try {
          if (btn) btn.disabled = true;
          await AdminAPI.saveSettings(state.token, {
            screensaver: {
              enabled: fd.has("enabled"),
              idleMinutes: Math.max(1, Number(fd.get("idleMinutes") || 5)),
              slideSeconds: Number(fd.get("slideSeconds") || 12),
              scheduleEnabled: fd.has("scheduleEnabled"),
              startTime: fd.get("startTime"),
              endTime: fd.get("endTime"),
              activeAlbumIds,
              sources: current.sources || [],
            },
          });
          toast("Screensaver saved");
          await refresh();
        } catch (err) {
          toast(apiErrorMessage(err));
        } finally {
          if (btn) btn.disabled = false;
        }
      });
    }

    const addSourceForm = $("#addSourceForm");
    if (addSourceForm) {
      addSourceForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(addSourceForm);
        const current = state.data?.settings?.screensaver || {};
        const sources = [...(current.sources || [])];
        const newId = `album_${Date.now()}`;
        const uploads = state.data?.screensaverPhotos || [];
        sources.push({
          id: newId,
          type: fd.get("type"),
          label: fd.get("label"),
          url: fd.get("url"),
          enabled: true,
        });
        const allIds = allAlbumIds(sources, uploads);
        const activeAlbumIds = Array.isArray(current.activeAlbumIds)
          ? [...new Set([...current.activeAlbumIds, newId])]
          : allIds;
        try {
          await AdminAPI.saveSettings(state.token, {
            screensaver: { ...current, sources, activeAlbumIds },
          });
          toast("Album added");
          await refresh();
        } catch (err) {
          toast(apiErrorMessage(err) || "Add failed");
        }
      });
    }

    $$("[data-del-source]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.delSource;
        const current = state.data?.settings?.screensaver || {};
        const sources = (current.sources || []).filter((s) => s.id !== id);
        const activeAlbumIds = Array.isArray(current.activeAlbumIds)
          ? current.activeAlbumIds.filter((aid) => aid !== id)
          : current.activeAlbumIds;
        try {
          await AdminAPI.saveSettings(state.token, {
            screensaver: { ...current, sources, activeAlbumIds },
          });
          toast("Album removed");
          await refresh();
        } catch (err) {
          toast(apiErrorMessage(err) || "Remove failed");
        }
      });
    });

    $$("[data-del-photo]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await AdminAPI.deletePhoto(state.token, btn.dataset.delPhoto);
          toast("Photo removed");
          await refresh();
        } catch (err) {
          toast(apiErrorMessage(err) || "Remove failed");
        }
      });
    });

    const photoUploadInput = $("#photoUploadInput");
    if (photoUploadInput) {
      photoUploadInput.addEventListener("change", async () => {
        const file = photoUploadInput.files?.[0];
        if (!file) return;
        try {
          const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          await AdminAPI.uploadPhoto(state.token, {
            filename: file.name,
            label: file.name.replace(/\.[^.]+$/, ""),
            data,
          });
          toast("Photo uploaded");
          photoUploadInput.value = "";
          await refresh();
        } catch (err) {
          toast(apiErrorMessage(err) || "Upload failed");
        }
      });
    }

    const deployBtn = $("#deployServerBtn");
    fillDeployMeta();
    if (state.filesToken) loadAdminFiles();

    $("#filesUnlockForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const password = $("#filesUnlockPassword")?.value || "";
      const btn = e.currentTarget.querySelector('button[type="submit"]');
      try {
        if (btn) btn.disabled = true;
        const data = await AdminAPI.unlockFiles(state.token, password);
        state.filesToken = data.filesToken || "";
        state.filesUnlocked = true;
        state.filesUnlockError = "";
        try {
          sessionStorage.setItem(FILES_TOKEN_KEY, state.filesToken);
        } catch {}
        renderTab();
      } catch (err) {
        state.filesUnlockError = apiErrorMessage(err) || "Wrong password";
        toast(state.filesUnlockError);
        renderTab();
        const input = $("#filesUnlockPassword");
        if (input) input.focus();
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    $("#lockFilesBtn")?.addEventListener("click", () => {
      lockFiles();
      renderTab();
    });

    $("#copyFileBtn")?.addEventListener("click", async () => {
      const text = $("#adminFileText")?.value || "";
      try {
        await navigator.clipboard.writeText(text);
        toast("Copied");
      } catch {
        toast("Copy failed — select the text and copy");
      }
    });

    $("#closeFileBtn")?.addEventListener("click", () => {
      state.adminFile = null;
      state.adminFileId = "";
      renderTab();
    });

    $("#adminFileForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const open = state.adminFile;
      if (!open?.writable) return;
      const btn = e.currentTarget.querySelector('button[type="submit"]');
      try {
        if (btn) btn.disabled = true;
        const content = $("#adminFileText")?.value || "";
        const saved = open.path
          ? await AdminAPI.saveBrowseFile(state.token, open.path, content, state.filesToken)
          : await AdminAPI.saveFile(state.token, state.adminFileId, content, state.filesToken);
        state.adminFile = saved;
        toast("File saved");
        await loadAdminFiles();
      } catch (err) {
        toast(apiErrorMessage(err) || "Save failed");
      } finally {
        if (btn) btn.disabled = false;
      }
    });
    if (deployBtn) {
      deployBtn.addEventListener("click", async () => {
        if (
          !confirm(
            "Pull the latest code from git and restart the server?\n\nRequires a git clone on this machine (not rsync-only)."
          )
        ) {
          return;
        }
        const statusEl = $("#restartStatus");
        deployBtn.disabled = true;
        $("#restartServerBtn")?.setAttribute("disabled", "true");
        if (statusEl) {
          statusEl.classList.remove("hidden");
          statusEl.textContent = "Pulling updates…";
        }
        try {
          const res = await AdminAPI.deploy(state.token);
          if (res.busy) {
            toast("Deploy already running");
            deployBtn.disabled = false;
            $("#restartServerBtn")?.removeAttribute("disabled");
            if (statusEl) statusEl.classList.add("hidden");
            return;
          }
        } catch (err) {
          toast(apiErrorMessage(err));
          deployBtn.disabled = false;
          $("#restartServerBtn")?.removeAttribute("disabled");
          if (statusEl) statusEl.classList.add("hidden");
          return;
        }
        if (statusEl) statusEl.textContent = "Pulling updates…";
        const deployResult = await waitForDeployFinish();
        await fillDeployMeta();
        if (!deployResult?.ok) {
          const msg = deployErrorMessage(deployResult);
          if (statusEl) statusEl.textContent = msg;
          toast(msg);
          deployBtn.disabled = false;
          $("#restartServerBtn")?.removeAttribute("disabled");
          return;
        }
        if (deployResult.pull?.dirtyBeforeSync) {
          toast("Local edits were discarded to match GitHub");
        } else if (deployResult.pull?.alreadyUpToDate) {
          toast("Already up to date — restarting");
        }
        if (statusEl) statusEl.textContent = "Restarting… waiting for server";
        await waitForServerRestart(statusEl, deployBtn);
        $("#restartServerBtn")?.removeAttribute("disabled");
      });
    }

    const tunnelBtn = $("#startTunnelBtn");
    if (tunnelBtn) {
      tunnelBtn.addEventListener("click", async () => {
        const statusEl = $("#restartStatus");
        tunnelBtn.disabled = true;
        if (statusEl) {
          statusEl.classList.remove("hidden");
          statusEl.textContent = "Starting Cloudflare tunnel…";
        }
        try {
          const res = await AdminAPI.startTunnel(state.token);
          await fillDeployMeta();
          const tun = res?.boot?.tunnel || res?.services?.tunnel || {};
          if (tun.active === "active") {
            toast("Tunnel is running — try https://family.fcchurchofgod.com/");
            if (statusEl) statusEl.textContent = "Tunnel running";
          } else {
            const detail = res?.error || res?.stdout || "Tunnel did not stay running";
            toast(detail);
            if (statusEl) statusEl.textContent = detail;
          }
        } catch (err) {
          toast(apiErrorMessage(err) || "Could not start tunnel — use home Wi‑Fi admin");
        }
        tunnelBtn.disabled = false;
      });
    }

    const restartBtn = $("#restartServerBtn");
    if (restartBtn) {
      restartBtn.addEventListener("click", async () => {
        if (
          !confirm(
            "Restart the Family Board server?\n\nThe TV displays will reconnect automatically. You'll need to log in again in admin."
          )
        ) {
          return;
        }
        const statusEl = $("#restartStatus");
        restartBtn.disabled = true;
        if (statusEl) {
          statusEl.classList.remove("hidden");
          statusEl.textContent = "Sending restart…";
        }
        try {
          await AdminAPI.restartServer(state.token);
        } catch {
          /* connection drop is expected */
        }
        await waitForServerRestart(statusEl, restartBtn);
      });
    }

    const rebootBtn = $("#rebootPiBtn");
    if (rebootBtn) {
      rebootBtn.addEventListener("click", async () => {
        if (
          !confirm(
            "Reboot the Raspberry Pi?\n\nThe TV will go dark for about a minute, then Family Board should come back on its own."
          )
        ) {
          return;
        }
        const statusEl = $("#restartStatus");
        rebootBtn.disabled = true;
        if (statusEl) {
          statusEl.classList.remove("hidden");
          statusEl.textContent = "Rebooting the Pi… this page will disconnect.";
        }
        try {
          const res = await AdminAPI.rebootPi(state.token);
          if (!res?.ok) {
            toast(res?.error || "Reboot failed");
            rebootBtn.disabled = false;
            return;
          }
          toast("Pi is rebooting");
        } catch (err) {
          toast(apiErrorMessage(err) || "Reboot failed — try again on the home Wi‑Fi");
          rebootBtn.disabled = false;
        }
      });
    }

    const logoutBtn = $("#logoutBtn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", () => {
        logoutSession();
      });
    }
  }

  window.addEventListener("admin-unauthorized", () => {
    logoutSession("Session expired — log in again");
  });

  $("#retryAdminBtn")?.addEventListener("click", () => enterAdmin());
  $("#loginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    await enterAdmin();
  });

  $(".nav")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tab]");
    if (!btn) return;
    e.preventDefault();
    state.tab = normalizeTab(btn.dataset.tab);
    renderTab();
  });

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.deferredPrompt = e;
    if (state.tab === "more") renderTab();
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((reg) => {
        if (location.pathname.startsWith("/phone") && !String(reg.scope).includes("/phone")) {
          reg.unregister();
        }
      });
    }).catch(() => {});
    navigator.serviceWorker.register("sw.js?v=16", { scope: "./" }).then((reg) => {
      reg.update();
    }).catch(() => {});
  }

  // Boot straight into admin (no password)
  (async () => {
    window.TouchInput?.attach?.();
    await checkServer();
    await enterAdmin();
  })();
})();
