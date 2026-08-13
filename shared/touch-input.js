/* Touchscreen add-item UI — on-screen keyboard */
(function () {
  const ROWS = [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l", "'"],
    ["z", "x", "c", "v", "b", "n", "m", ",", ".", "⌫"],
  ];

  let overlay = null;
  let value = "";
  let onSubmit = null;

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
          <div class="touch-keyboard" id="touchKeyboard"></div>
        </div>
        <div class="touch-input-foot">
          <button type="button" class="cancel" id="touchInputCancel">Cancel</button>
          <button type="button" class="submit" id="touchInputSubmit" disabled>Add</button>
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

  function buildKeyboard(root) {
    root.innerHTML = "";
    ROWS.forEach((row) => {
      const rowEl = document.createElement("div");
      rowEl.className = `touch-kb-row${row.length === 9 ? " row-9" : ""}`;
      row.forEach((key) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "touch-key";
        btn.textContent = key;
        btn.addEventListener("click", () => {
          if (key === "⌫") backspace();
          else append(key);
        });
        rowEl.appendChild(btn);
      });
      root.appendChild(rowEl);
    });
    const bottom = document.createElement("div");
    bottom.className = "touch-kb-row touch-kb-bottom";
    bottom.innerHTML = `
      <button type="button" class="touch-key space" data-key="space">Space</button>
      <button type="button" class="touch-key clear-key" data-key="clear">Clear</button>`;
    bottom.querySelector('[data-key="space"]').addEventListener("click", () => append(" "));
    bottom.querySelector('[data-key="clear"]').addEventListener("click", () => {
      value = "";
      updatePreview();
    });
    root.appendChild(bottom);
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
    el.textContent = trimmed || el.dataset.placeholder || "Type here…";
    el.classList.toggle("empty", !trimmed);
    overlay.querySelector("#touchInputSubmit").disabled = !trimmed;
  }

  function close() {
    overlay.classList.remove("open");
    value = "";
    onSubmit = null;
  }

  async function submit() {
    const text = value.trim();
    if (!text || !onSubmit) return;
    const fn = onSubmit;
    close();
    await fn(text);
  }

  function open(opts) {
    ensureOverlay();
    value = opts.initialValue || "";
    onSubmit = opts.onSubmit || null;
    overlay.querySelector("#touchInputTitle").textContent = opts.title || "Add item";
    overlay.querySelector("#touchInputPreview").dataset.placeholder =
      opts.placeholder || "Type here…";
    updatePreview();
    overlay.classList.add("open");
  }

  window.TouchInput = { open, close };
})();
