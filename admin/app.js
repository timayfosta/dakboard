(() => {
  const TOKEN_KEY = "family-admin-token";
  const THEME_KEY = "family-admin-theme";
  const REQUIRED_API_VERSION = 2;
  const state = {
    token: localStorage.getItem(TOKEN_KEY) || "",
    tab: "lists",
    data: null,
    deferredPrompt: null,
    listsFp: "",
    serverOk: true,
    serverHint: "",
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
  }

  document.addEventListener("click", (e) => {
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
    $("#loginView").classList.toggle("hidden", on);
    $("#appView").classList.toggle("hidden", !on);
  }

  function logoutSession(message) {
    localStorage.removeItem(TOKEN_KEY);
    state.token = "";
    clearInterval(listPollTimer);
    setAuthed(false);
    if (message) toast(message);
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

  function renderTab() {
    $$(".nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
    const root = $("#tabContent");
    const d = state.data;
    if (state.tab === "kids") root.innerHTML = renderKids(d);
    if (state.tab === "chores") root.innerHTML = renderChores(d);
    if (state.tab === "lists") root.innerHTML = renderLists(d);
    if (state.tab === "rewards") root.innerHTML = renderRewards(d);
    if (state.tab === "more") root.innerHTML = renderMore(d);
    wireTabActions();
    syncThemeButtons();
  }

  function renderKids(d) {
    return `
      <section class="card">
        <h2>Add kid</h2>
        <form id="kidForm">
          <input type="hidden" name="id" value="" />
          <div class="field"><label>Name</label><input name="name" required placeholder="Maya" /></div>
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
          <div class="field"><label>Title</label><input name="title" required placeholder="Make bed" /></div>
          <div class="field">
            <label>Emoji</label>
            ${renderEmojiPicker("icon", CHORE_EMOJIS, "✅")}
          </div>
          <div class="field"><label>Stars</label><input name="stars" type="number" min="1" max="99" value="1" /></div>
          <div class="field"><label>Hint (optional)</label><input name="hint" placeholder="Before school — pull covers neat" /></div>
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

  function renderLists(d) {
    const block = (name, title) => `
      <section class="card">
        <h2>${title}</h2>
        <form data-list-add="${name}" class="row" style="margin-bottom:0.65rem">
          <input name="text" placeholder="Add item" required class="list-add-input" />
          <button class="btn" type="submit">Add</button>
        </form>
        <div class="list">
          ${(d.lists?.[name] || [])
            .filter((item) => !item.done)
            .map(
              (item) => `
            <button class="item" data-list-toggle="${name}" data-id="${item.id}" style="text-align:left;width:100%;cursor:pointer">
              <div class="row">
                <div class="title">⬜️ ${item.text}</div>
                <span class="muted" style="flex-shrink:0">Tap to clear</span>
              </div>
            </button>`
            )
            .join("") || `<p class="muted">No items — add above</p>`}
        </div>
      </section>`;
    return block("grocery", "Groceries") + block("reminders", "Reminders");
  }

  function renderRewards(d) {
    return `
      <section class="card">
        <h2>Add reward</h2>
        <form id="rewardForm">
          <div class="field"><label>Title</label><input name="title" required placeholder="Pick dessert" /></div>
          <div class="field"><label>Emoji</label><input name="icon" value="🎁" maxlength="4" /></div>
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
        <p class="muted night-hint">Day / Night theme for this admin app (saved on this phone).</p>
        <div class="theme-switch" role="group" aria-label="Appearance">
          <button type="button" data-theme-set="day"><span class="ico" aria-hidden="true">☀</span> Day</button>
          <button type="button" data-theme-set="night"><span class="ico" aria-hidden="true">☾</span> Night</button>
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
              <input name="label" placeholder="Family trip" required />
            </div>
            <div class="field">
              <label>Link or URLs</label>
              <textarea name="url" rows="3" placeholder="https://photos.app.goo.gl/..." required></textarea>
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
        <h2>Display links</h2>
        <p class="muted">Open these on the Pi / TV kiosk.</p>
        <div class="actions link-grid">
          <a class="btn secondary" href="/screens/calendar.html?kiosk=1">Calendar</a>
          <a class="btn secondary" href="/screens/chores.html">Chores</a>
          <a class="btn secondary" href="/screens/rewards.html">Rewards</a>
          <a class="btn secondary" href="/screens/whiteboard.html?kiosk=1">Whiteboard</a>
        </div>
      </section>
      <section class="card">
        <h2>Server</h2>
        <p class="muted">
          On push to GitHub, the Pi should auto pull + restart (Actions or webhook).
          Open screens and this admin app then auto-refresh.
        </p>
        <p class="muted" id="deployMeta">Checking deploy status…</p>
        <button class="btn block" type="button" id="deployServerBtn">Pull updates &amp; restart now</button>
        <button class="btn secondary block" type="button" id="restartServerBtn">Restart only</button>
        <p class="muted restart-status hidden" id="restartStatus"></p>
      </section>
      <section class="card">
        <h2>Session</h2>
        <button class="btn danger block" id="logoutBtn">Log out</button>
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
      else if (last?.ok) bits.push("last deploy ok");
      el.textContent = bits.join(" · ");
    } catch {
      el.textContent = "Can't reach server health check";
    }
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
              await AdminAPI.toggleListItem(state.token, name, res.item.id);
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
          await refresh();
          if (res.item && window.ListUndo) {
            ListUndo.offer(`Removed "${res.item.text}"`, async () => {
              await AdminAPI.restoreListItem(name, res.item, res.index);
              await refresh();
            });
          } else {
            toast("Cleared");
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
          }
        } catch (err) {
          toast(apiErrorMessage(err));
        }
        if (statusEl) statusEl.textContent = "Restarting… waiting for server";
        await waitForServerRestart(statusEl, deployBtn);
        $("#restartServerBtn")?.removeAttribute("disabled");
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

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = new FormData(e.target).get("password");
    try {
      const res = await AdminAPI.login(password);
      state.token = res.token;
      localStorage.setItem(TOKEN_KEY, res.token);
      setAuthed(true);
      await refresh();
      syncListPolling();
      toast("Welcome");
    } catch (err) {
      const msg = String(err.message || err);
      if (msg.includes("501") || msg.includes("Failed to fetch") || msg.includes("Unsupported")) {
        toast("Server not running — run: npm start");
      } else {
        toast(msg || "Login failed");
      }
    }
  });

  $$(".nav button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      renderTab();
    });
  });

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.deferredPrompt = e;
    if (state.tab === "more") renderTab();
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js?v=11").then((reg) => {
      reg.update();
    }).catch(() => {});
  }

  // Boot: if token exists, validate session; else login
  (async () => {
    await checkServer();
    if (!state.token) {
      setAuthed(false);
      return;
    }
    try {
      await AdminAPI.session(state.token);
      setAuthed(true);
      await refresh();
      syncListPolling();
    } catch {
      logoutSession("Session expired — log in again");
    }
  })();
})();
