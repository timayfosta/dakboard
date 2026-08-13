/* Brief undo toast after grocery/reminder changes */
(function () {
  const UNDO_MS = 8000;
  let toastEl = null;
  let timer = null;
  let undoFn = null;

  function ensureToast() {
    if (toastEl) return toastEl;
    toastEl = document.createElement("div");
    toastEl.className = "list-undo-toast";
    toastEl.setAttribute("role", "status");
    toastEl.innerHTML =
      '<span class="list-undo-msg"></span><button type="button" class="list-undo-btn">Undo</button>';
    toastEl.querySelector(".list-undo-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      runUndo();
    });
    document.body.appendChild(toastEl);
    return toastEl;
  }

  function hide() {
    clearTimeout(timer);
    undoFn = null;
    toastEl?.classList.remove("show");
  }

  async function runUndo() {
    const fn = undoFn;
    hide();
    if (fn) await fn();
  }

  function offer(message, onUndo) {
    const el = ensureToast();
    el.querySelector(".list-undo-msg").textContent = message;
    undoFn = onUndo;
    el.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(hide, UNDO_MS);
  }

  window.ListUndo = { offer, hide };
})();
