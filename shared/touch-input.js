/* Touchscreen QWERTY keyboard with Samsung-style swipe-to-type */
(function () {
  const LETTER_ROWS = [
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
    ["z", "x", "c", "v", "b", "n", "m"],
  ];
  const NUMBER_ROW = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
  const SWIPE_MIN_PX = 48;
  const SWIPE_MIN_SAMPLES = 8;

  let overlay = null;
  let value = "";
  let onSubmit = null;
  let fieldEl = null;
  let mode = "add";
  let shifted = false;
  let attached = false;
  let swipe = null;
  let lastWord = "";
  let suggestions = [];

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

  function isOpen() {
    return !!overlay?.classList.contains("open");
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
        <div class="touch-suggest" id="touchSuggest" hidden></div>
        <div class="touch-input-body">
          <div class="touch-keyboard" id="touchKeyboard">
            <canvas class="touch-swipe-trail" id="touchSwipeTrail"></canvas>
          </div>
        </div>
        <div class="touch-input-foot">
          <button type="button" class="cancel" id="touchInputCancel">Cancel</button>
          <button type="button" class="submit" id="touchInputSubmit" disabled>Add</button>
        </div>
      </div>`;

    document.querySelector(".tv-frame")?.appendChild(overlay) || document.body.appendChild(overlay);

    overlay.querySelector(".touch-input-close").addEventListener("click", close);
    overlay.querySelector("#touchInputCancel").addEventListener("click", close);
    overlay.querySelector("#touchInputSubmit").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      submit();
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector("#touchSuggest").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-suggest]");
      if (!btn) return;
      replaceLastWord(btn.dataset.suggest);
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

  function keyCenters() {
    const kb = overlay.querySelector("#touchKeyboard");
    const kbRect = kb.getBoundingClientRect();
    const map = {};
    let keySize = 48;
    kb.querySelectorAll(".touch-key[data-ch]").forEach((btn) => {
      const ch = (btn.dataset.ch || "").toLowerCase();
      if (!/^[a-z]$/.test(ch)) return;
      const r = btn.getBoundingClientRect();
      map[ch] = {
        x: r.left - kbRect.left + r.width / 2,
        y: r.top - kbRect.top + r.height / 2,
      };
      keySize = Math.max(keySize, (r.width + r.height) / 2);
    });
    return { map, keySize, origin: { x: kbRect.left, y: kbRect.top } };
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function pointToSegDist(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (!len2) return dist(p, a);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function pointToPolylineDist(p, line) {
    if (!line.length) return 1e9;
    if (line.length === 1) return dist(p, line[0]);
    let best = 1e9;
    for (let i = 1; i < line.length; i += 1) {
      best = Math.min(best, pointToSegDist(p, line[i - 1], line[i]));
    }
    return best;
  }

  function polylineLength(line) {
    let n = 0;
    for (let i = 1; i < line.length; i += 1) n += dist(line[i - 1], line[i]);
    return n;
  }

  function resample(line, count) {
    if (line.length < 2) return line.slice();
    const total = polylineLength(line);
    if (total < 1) return [line[0], line[line.length - 1]];
    const out = [line[0]];
    const step = total / (count - 1);
    let passed = 0;
    let seg = 0;
    let acc = 0;
    for (let i = 1; i < count - 1; i += 1) {
      const target = step * i;
      while (seg < line.length - 1) {
        const d = dist(line[seg], line[seg + 1]);
        if (acc + d >= target) {
          const t = d ? (target - acc) / d : 0;
          out.push({
            x: line[seg].x + (line[seg + 1].x - line[seg].x) * t,
            y: line[seg].y + (line[seg + 1].y - line[seg].y) * t,
          });
          break;
        }
        acc += d;
        seg += 1;
      }
    }
    out.push(line[line.length - 1]);
    return out;
  }

  function idealPath(word, centers) {
    const pts = [];
    for (const ch of word) {
      const p = centers[ch];
      if (!p) return null;
      if (!pts.length || dist(pts[pts.length - 1], p) > 1) pts.push(p);
    }
    return pts.length ? pts : null;
  }

  function scoreWord(word, userPts, centers, keySize) {
    const ideal = idealPath(word, centers);
    if (!ideal || userPts.length < 2) return -1e9;
    const startD = dist(userPts[0], ideal[0]) / keySize;
    const endD = dist(userPts[userPts.length - 1], ideal[ideal.length - 1]) / keySize;
    if (startD > 1.25 || endD > 1.35) return -1e9;

    const sampledUser = resample(userPts, 20);
    const sampledIdeal = resample(ideal, 20);
    let userToIdeal = 0;
    sampledUser.forEach((p) => {
      userToIdeal += pointToPolylineDist(p, sampledIdeal);
    });
    userToIdeal = userToIdeal / sampledUser.length / keySize;

    let lettersToUser = 0;
    ideal.forEach((p) => {
      lettersToUser += pointToPolylineDist(p, sampledUser);
    });
    lettersToUser = lettersToUser / ideal.length / keySize;

    const userLen = polylineLength(userPts);
    const idealLen = Math.max(1, polylineLength(ideal));
    const lenPen = Math.abs(Math.log(userLen / idealLen));

    return 8 - startD * 1.6 - endD * 1.7 - userToIdeal * 2.1 - lettersToUser * 1.8 - lenPen * 0.9 + Math.min(word.length, 8) * 0.04;
  }

  function rankSwipe(userPts, centers, keySize) {
    const ranked = [];
    for (const raw of wordList()) {
      const word = String(raw || "").toLowerCase();
      if (word.length < 2) continue;
      const score = scoreWord(word, userPts, centers, keySize);
      if (score < 1.05) continue;
      ranked.push({ word, score });
    }
    ranked.sort((a, b) => b.score - a.score || b.word.length - a.word.length);
    const seen = new Set();
    return ranked.filter((row) => {
      if (seen.has(row.word)) return false;
      seen.add(row.word);
      return true;
    }).slice(0, 3);
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
      const { origin } = keyCenters();
      swipe = {
        points: [],
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        pointerId: e.pointerId,
        origin: key,
      };
      addSwipePoint(e.clientX - origin.x, e.clientY - origin.y);
      key.classList.add("press");
    });

    root.addEventListener("pointermove", (e) => {
      if (!swipe || swipe.pointerId !== e.pointerId) return;
      const dx = e.clientX - swipe.startX;
      const dy = e.clientY - swipe.startY;
      if (Math.hypot(dx, dy) > 12) swipe.moved = true;
      const { origin } = keyCenters();
      addSwipePoint(e.clientX - origin.x, e.clientY - origin.y);
      const key = keyFromPoint(e.clientX, e.clientY);
      if (key?.dataset.ch) key.classList.add("swipe-on");
      drawTrail();
    });

    const endSwipe = (e) => {
      if (!swipe || (e && swipe.pointerId !== e.pointerId)) return;
      overlay.querySelectorAll(".touch-key.press, .touch-key.swipe-on").forEach((k) => {
        k.classList.remove("press", "swipe-on");
      });
      const distPx = Math.hypot(
        (e?.clientX || swipe.startX) - swipe.startX,
        (e?.clientY || swipe.startY) - swipe.startY
      );
      const isSwipe = swipe.moved && swipe.points.length >= SWIPE_MIN_SAMPLES && distPx >= SWIPE_MIN_PX;
      if (isSwipe) {
        const { map, keySize } = keyCenters();
        const ranked = rankSwipe(swipe.points, map, keySize);
        suggestions = ranked.map((row) => row.word);
        if (ranked[0]) appendWord(ranked[0].word);
        else showSuggestions([]);
      } else if (swipe.origin) {
        suggestions = [];
        showSuggestions([]);
        tapKey(swipe.origin);
      }
      swipe = null;
      clearTrail();
    };

    root.addEventListener("pointerup", endSwipe);
    root.addEventListener("pointercancel", endSwipe);
  }

  function addSwipePoint(x, y) {
    if (!swipe) return;
    const pts = swipe.points;
    const last = pts[pts.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y) < 3) return;
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
    ctx.strokeStyle = "rgba(90, 167, 255, 0.9)";
    ctx.lineWidth = 6;
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

  function showSuggestions(words) {
    const bar = overlay.querySelector("#touchSuggest");
    if (!words.length) {
      bar.hidden = true;
      bar.innerHTML = "";
      return;
    }
    bar.hidden = false;
    bar.innerHTML = words
      .map((word, i) => `<button type="button" class="touch-suggest-btn${i === 0 ? " top" : ""}" data-suggest="${word}">${word}</button>`)
      .join("");
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
      lastWord = "";
      suggestions = [];
      showSuggestions([]);
      return;
    }
    if (action === "clear") {
      value = "";
      lastWord = "";
      suggestions = [];
      showSuggestions([]);
      updatePreview();
      return;
    }
    const ch = btn.dataset.ch;
    if (!ch) return;
    append(/^[a-z]$/i.test(ch) ? letterLabel(ch.toLowerCase()) : ch);
    lastWord = "";
    suggestions = [];
    showSuggestions([]);
    if (shifted && /^[a-z]$/i.test(ch)) {
      shifted = false;
      refreshShift();
    }
  }

  function formatWord(word) {
    return shifted ? word.charAt(0).toUpperCase() + word.slice(1) : word;
  }

  function appendWord(word) {
    const next = formatWord(word);
    if (value && !/\s$/.test(value)) value += " ";
    value += `${next} `;
    lastWord = next;
    shifted = false;
    refreshShift();
    showSuggestions(suggestions);
    updatePreview();
  }

  function replaceLastWord(word) {
    if (!word) return;
    const next = formatWord(word);
    if (lastWord) {
      const re = new RegExp(`${lastWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
      if (re.test(value)) value = value.replace(re, `${next} `);
      else value += `${next} `;
    } else {
      if (value && !/\s$/.test(value)) value += " ";
      value += `${next} `;
    }
    lastWord = next;
    updatePreview();
  }

  function append(text) {
    value += text;
    updatePreview();
  }

  function backspace() {
    value = value.slice(0, -1);
    lastWord = "";
    updatePreview();
  }

  function updatePreview() {
    const el = overlay.querySelector("#touchInputPreview");
    const trimmed = value.trim();
    el.textContent = value || el.dataset.placeholder || "Type here…";
    el.classList.toggle("empty", !trimmed);
    overlay.querySelector("#touchInputSubmit").disabled = !trimmed;
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove("open");
    value = "";
    onSubmit = null;
    fieldEl = null;
    mode = "add";
    shifted = false;
    swipe = null;
    lastWord = "";
    suggestions = [];
    showSuggestions([]);
  }

  async function submit() {
    const text = value.trim();
    if (!text) return;
    const fn = onSubmit;
    const field = fieldEl;
    const add = mode === "add";
    close();
    if (field) {
      field.value = text;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (add && fn) await fn(text);
  }

  function open(opts = {}) {
    ensureOverlay();
    value = opts.initialValue || "";
    onSubmit = opts.onSubmit || null;
    fieldEl = opts.field || null;
    mode = opts.mode || (fieldEl ? "field" : "add");
    shifted = false;
    lastWord = "";
    suggestions = [];
    overlay.querySelector("#touchInputTitle").textContent = opts.title || "Type";
    overlay.querySelector("#touchInputPreview").dataset.placeholder =
      opts.placeholder || "Swipe a word or tap letters…";
    overlay.querySelector("#touchInputSubmit").textContent = opts.submitLabel || (mode === "field" ? "Done" : "Add");
    refreshShift();
    showSuggestions([]);
    updatePreview();
    overlay.classList.add("open");
  }

  function openForField(el) {
    if (!el || !isTextBox(el) || isOpen()) return;
    open({
      title: fieldTitle(el),
      placeholder: el.placeholder || "Swipe a word or tap letters…",
      initialValue: el.value || "",
      field: el,
      mode: "field",
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
        if (!useCustomKeyboard() || isOpen()) return;
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
        if (!useCustomKeyboard() || isOpen()) return;
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
