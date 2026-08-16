/* Touchscreen QWERTY keyboard with swipe-to-type */
(function () {
  const LETTER_ROWS = [
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
    ["z", "x", "c", "v", "b", "n", "m"],
  ];
  const NUMBER_ROW = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
  const SWIPE_MIN_KEYS = 2;
  const SWIPE_MIN_PX = 36;

  let overlay = null;
  let value = "";
  let onSubmit = null;
  let fieldEl = null;
  let shifted = false;
  let attached = false;
  let swipe = null;

  function wordList() {
    return window.SWIPE_WORDS || [];
  }

  function useCustomKeyboard() {
    if (document.body.classList.contains("kiosk") || document.body.classList.contains("tv-stage")) {
      return true;
    }
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const minSide = Math.min(window.innerWidth, window.innerHeight);
    return coarse && minSide >= 700;
  }

  function isTextBox(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.closest(".touch-input-overlay")) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag !== "INPUT") return false;
    const type = (el.type || "text").toLowerCase();
    return ["text", "search", "password", "email", "url", "tel", "number"].includes(type);
  }

  function fieldTitle(el) {
    const id = el.id;
    if (id) {
      const lab = document.querySelector(`label[for="${id}"]`);
      if (lab?.textContent) return lab.textContent.trim();
    }
    const wrap = el.closest(".field");
    const near = wrap?.querySelector("label");
    if (near?.textContent) return near.textContent.trim();
    return el.placeholder || el.getAttribute("aria-label") || "Type";
  }

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "touch-input-overlay";
    overlay.innerHTML = `
      <div class="touch-input-sheet" role="dialog" aria-modal="true">
        <div class="touch-input-head">
          <h3 id="touchInputTitle">Add item</h3>
          <button type="button" class="touch-input-close" aria-label="Close">✕</button>
        </div>
        <div class="touch-input-preview empty" id="touchInputPreview">Type here…</div>
        <div class="touch-input-body">
          <div class="touch-keyboard" id="touchKeyboard">
            <canvas class="touch-swipe-trail" id="touchSwipeTrail"></canvas>
          </div>
        </div>
        <div class="touch-input-foot">
          <button type="button" class="cancel" id="touchInputCancel">Cancel</button>
          <button type="button" class="submit" id="touchInputSubmit" disabled>Done</button>
        </div>
      </div>`;

    document.querySelector(".tv-frame")?.appendChild(overlay) || document.body.appendChild(overlay);

    overlay.querySelector(".touch-input-close").addEventListener("click", close);
    overlay.querySelector("#touchInputCancel").addEventListener("click", close);
    overlay.querySelector("#touchInputSubmit").addEventListener("click", submit);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    buildKeyboard(overlay.querySelector("#touchKeyboard"));
    return overlay;
  }

  function keyButton(label, opts = {}) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `touch-key${opts.cls ? ` ${opts.cls}` : ""}`;
    btn.textContent = label;
    if (opts.ch) btn.dataset.ch = opts.ch;
    if (opts.action) btn.dataset.action = opts.action;
    return btn;
  }

  function buildKeyboard(root) {
    const trail = root.querySelector("#touchSwipeTrail");
    root.innerHTML = "";
    if (trail) root.appendChild(trail);

    const num = document.createElement("div");
    num.className = "touch-kb-row";
    NUMBER_ROW.forEach((ch) => num.appendChild(keyButton(ch, { ch })));
    root.appendChild(num);

    LETTER_ROWS.forEach((row, idx) => {
      const rowEl = document.createElement("div");
      rowEl.className = `touch-kb-row${idx === 1 ? " row-9" : ""}${idx === 2 ? " row-letters-bottom" : ""}`;
      if (idx === 2) rowEl.appendChild(keyButton("⇧", { action: "shift", cls: "shift-key" }));
      row.forEach((ch) => rowEl.appendChild(keyButton(ch, { ch })));
      if (idx === 2) rowEl.appendChild(keyButton("⌫", { action: "backspace", cls: "back-key" }));
      root.appendChild(rowEl);
    });

    const bottom = document.createElement("div");
    bottom.className = "touch-kb-row touch-kb-bottom";
    bottom.appendChild(keyButton(",", { ch: "," }));
    bottom.appendChild(keyButton("Space", { action: "space", cls: "space" }));
    bottom.appendChild(keyButton(".", { ch: "." }));
    bottom.appendChild(keyButton("Clear", { action: "clear", cls: "clear-key" }));
    root.appendChild(bottom);

    bindKeyboardPointer(root);
  }

  function letterLabel(ch) {
    if (!/^[a-z]$/.test(ch)) return ch;
    return shifted ? ch.toUpperCase() : ch;
  }

  function refreshShift() {
    if (!overlay) return;
    overlay.querySelectorAll(".touch-key[data-ch]").forEach((btn) => {
      const ch = btn.dataset.ch;
      if (/^[a-z]$/i.test(ch)) btn.textContent = letterLabel(ch.toLowerCase());
    });
    overlay.querySelector(".shift-key")?.classList.toggle("on", shifted);
  }

  function keyFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    return el?.closest?.(".touch-key") || null;
  }

  function bindKeyboardPointer(root) {
    root.addEventListener("pointerdown", (e) => {
      const key = e.target.closest(".touch-key");
      if (!key) return;
      e.preventDefault();
      root.setPointerCapture?.(e.pointerId);
      const rect = root.getBoundingClientRect();
      swipe = {
        keys: [],
        points: [],
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        pointerId: e.pointerId,
        origin: key,
      };
      addSwipeKey(key);
      addSwipePoint(e.clientX - rect.left, e.clientY - rect.top);
      key.classList.add("press");
    });

    root.addEventListener("pointermove", (e) => {
      if (!swipe || swipe.pointerId !== e.pointerId) return;
      const dx = e.clientX - swipe.startX;
      const dy = e.clientY - swipe.startY;
      if (Math.hypot(dx, dy) > 10) swipe.moved = true;
      const rect = root.getBoundingClientRect();
      addSwipePoint(e.clientX - rect.left, e.clientY - rect.top);
      const key = keyFromPoint(e.clientX, e.clientY);
      if (key) addSwipeKey(key);
      drawTrail();
    });

    const endSwipe = (e) => {
      if (!swipe || (e && swipe.pointerId !== e.pointerId)) return;
      overlay.querySelectorAll(".touch-key.press, .touch-key.swipe-on").forEach((k) => {
        k.classList.remove("press", "swipe-on");
      });
      const path = swipe.keys.filter((k) => k.dataset.ch && /^[a-z]$/i.test(k.dataset.ch));
      const dist = Math.hypot(
        (e?.clientX || swipe.startX) - swipe.startX,
        (e?.clientY || swipe.startY) - swipe.startY
      );
      const isSwipe = swipe.moved && path.length >= SWIPE_MIN_KEYS && dist >= SWIPE_MIN_PX;
      if (isSwipe) {
        const word = matchSwipe(path.map((k) => k.dataset.ch.toLowerCase()));
        if (word) appendWord(word);
      } else if (swipe.origin) {
        tapKey(swipe.origin);
      }
      swipe = null;
      clearTrail();
    };

    root.addEventListener("pointerup", endSwipe);
    root.addEventListener("pointercancel", endSwipe);
  }

  function addSwipeKey(key) {
    if (!swipe) return;
    const last = swipe.keys[swipe.keys.length - 1];
    if (last === key) return;
    swipe.keys.push(key);
    key.classList.add("swipe-on");
  }

  function addSwipePoint(x, y) {
    if (!swipe) return;
    const pts = swipe.points;
    const last = pts[pts.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y) < 4) return;
    pts.push({ x, y });
  }

  function drawTrail() {
    const canvas = overlay?.querySelector("#touchSwipeTrail");
    const kb = overlay?.querySelector("#touchKeyboard");
    if (!canvas || !kb || !swipe?.points.length) return;
    const w = kb.clientWidth;
    const h = kb.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(255, 122, 89, 0.85)";
    ctx.lineWidth = 5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    swipe.points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  }

  function clearTrail() {
    const canvas = overlay?.querySelector("#touchSwipeTrail");
    if (!canvas) return;
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  }

  function matchSwipe(keys) {
    if (keys.length < 2) return "";
    const first = keys[0];
    const last = keys[keys.length - 1];
    let best = "";
    let bestScore = 0;
    for (const raw of wordList()) {
      const word = String(raw || "").toLowerCase();
      if (word.length < 2 || word[0] !== first || word[word.length - 1] !== last) continue;
      let ki = 0;
      let ok = true;
      for (const ch of word) {
        while (ki < keys.length && keys[ki] !== ch) ki += 1;
        if (ki >= keys.length) {
          ok = false;
          break;
        }
        ki += 1;
      }
      if (!ok) continue;
      const extra = keys.length - word.length;
      const score = 200 - extra * 3 - Math.abs(keys.length - word.length) + word.length;
      if (score > bestScore) {
        bestScore = score;
        best = word;
      }
    }
    return best;
  }

  function tapKey(btn) {
    const action = btn.dataset.action;
    if (action === "shift") {
      shifted = !shifted;
      refreshShift();
      return;
    }
    if (action === "backspace") {
      backspace();
      return;
    }
    if (action === "space") {
      append(" ");
      return;
    }
    if (action === "clear") {
      value = "";
      updatePreview();
      return;
    }
    const ch = btn.dataset.ch;
    if (!ch) return;
    append(/^[a-z]$/i.test(ch) ? letterLabel(ch.toLowerCase()) : ch);
    if (shifted && /^[a-z]$/i.test(ch)) {
      shifted = false;
      refreshShift();
    }
  }

  function appendWord(word) {
    const next = shifted ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    if (value && !value.endsWith(" ")) value += " ";
    value += `${next} `;
    shifted = false;
    refreshShift();
    updatePreview();
  }

  function append(text) {
    value += text;
    updatePreview();
  }

  function backspace() {
    value = value.slice(0, -1);
    updatePreview();
  }

  function updatePreview() {
    const el = overlay.querySelector("#touchInputPreview");
    const trimmed = value.trim();
    el.textContent = value || el.dataset.placeholder || "Type here…";
    el.classList.toggle("empty", !value);
    overlay.querySelector("#touchInputSubmit").disabled = !trimmed && !fieldEl;
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove("open");
    value = "";
    onSubmit = null;
    fieldEl = null;
    shifted = false;
    swipe = null;
  }

  async function submit() {
    const text = value.trim();
    const fn = onSubmit;
    const field = fieldEl;
    close();
    if (field) {
      field.value = text;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (!text || !fn) return;
    await fn(text);
  }

  function open(opts = {}) {
    ensureOverlay();
    value = opts.initialValue || "";
    onSubmit = opts.onSubmit || null;
    fieldEl = opts.field || null;
    shifted = false;
    overlay.querySelector("#touchInputTitle").textContent = opts.title || "Type";
    overlay.querySelector("#touchInputPreview").dataset.placeholder =
      opts.placeholder || "Type here…";
    overlay.querySelector("#touchInputSubmit").textContent = opts.submitLabel || (fieldEl ? "Done" : "Add");
    refreshShift();
    updatePreview();
    overlay.classList.add("open");
  }

  function openForField(el) {
    if (!el || !isTextBox(el)) return;
    open({
      title: fieldTitle(el),
      placeholder: el.placeholder || "Type here…",
      initialValue: el.value || "",
      field: el,
      submitLabel: "Done",
    });
  }

  function markTextFields(root = document) {
    root.querySelectorAll("input, textarea").forEach((el) => {
      if (!isTextBox(el)) return;
      if (!el.getAttribute("inputmode") && el.type !== "number" && el.type !== "tel") {
        el.setAttribute("inputmode", "text");
      }
      if (!el.getAttribute("enterkeyhint")) el.setAttribute("enterkeyhint", "done");
    });
  }

  function attach() {
    if (attached) {
      markTextFields();
      return;
    }
    attached = true;
    markTextFields();
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!useCustomKeyboard()) return;
        const el = e.target.closest?.("input, textarea");
        if (!isTextBox(el)) return;
        e.preventDefault();
        e.stopPropagation();
        openForField(el);
      },
      true
    );
    document.addEventListener(
      "focusin",
      (e) => {
        if (!useCustomKeyboard()) return;
        const el = e.target;
        if (!isTextBox(el)) return;
        el.blur();
        openForField(el);
      },
      true
    );
  }

  window.TouchInput = { open, close, attach, markTextFields };
})();
