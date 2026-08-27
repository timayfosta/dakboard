/* Family Board — full-screen touch whiteboard (vector strokes, server sync) */
(function () {
  const SIZES = [
    { id: "s", value: 4, label: "S" },
    { id: "m", value: 8, label: "M" },
    { id: "l", value: 14, label: "L" },
    { id: "xl", value: 24, label: "XL" },
  ];

  const TOOLS = [
    { id: "pen", label: "Pen", icon: "✏️" },
    { id: "marker", label: "Marker", icon: "🖊️" },
    { id: "highlighter", label: "Highlighter", icon: "🖍️" },
    { id: "pencil", label: "Pencil", icon: "✎" },
    { id: "line", label: "Line", icon: "╱" },
    { id: "rect", label: "Box", icon: "▢" },
    { id: "circle", label: "Circle", icon: "○" },
    { id: "eraser", label: "Eraser", icon: "🧽" },
  ];

  const SHAPE_TOOLS = new Set(["line", "rect", "circle"]);

  const TOOL_DEFS = {
    pen: { sizeMul: 1 },
    marker: { sizeMul: 1.55 },
    highlighter: { opacity: 0.36, sizeMul: 2.6 },
    pencil: { sizeMul: 0.65 },
    line: { sizeMul: 1 },
    rect: { sizeMul: 1 },
    circle: { sizeMul: 1 },
    eraser: { sizeMul: 1, minSize: 12 },
  };

  let canvas = null;
  let ctx = null;
  let backing = null;
  let backingCtx = null;
  let toolbarEl = null;
  let strokes = [];
  let currentStroke = null;
  let tool = "pen";
  let color = "#f2f4f8";
  const DEFAULT_NIGHT_INK = "#f2f4f8";
  const DEFAULT_DAY_INK = "#0f172a";
  let size = SIZES[1].value;
  let lastSavedAt = 0;
  let localRevision = 0;
  let saveTimer = null;
  let pollTimer = null;
  let drawing = false;
  let clearArmed = false;
  let clearTimer = null;
  let drawRaf = 0;
  let canvasW = 0;
  let canvasH = 0;

  function normalizeTool(id) {
    return TOOL_DEFS[id] ? id : "pen";
  }

  function strokeSize(stroke) {
    const def = TOOL_DEFS[stroke.tool] || TOOL_DEFS.pen;
    const base = Number(stroke.size) || 8;
    if (stroke.tool === "eraser") return Math.max(base, def.minSize || 12);
    return Math.max(1, base * (def.sizeMul || 1));
  }

  function cssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function canvasBg() {
    return cssVar("--wb-canvas", "#161616");
  }

  function defaultInk() {
    return cssVar("--wb-ink", DEFAULT_NIGHT_INK);
  }

  function isDefaultInk(hex) {
    const n = String(hex || "").toLowerCase();
    return n === DEFAULT_NIGHT_INK || n === DEFAULT_DAY_INK || n === "#ffffff" || n === "#fff";
  }

  function strokePaintColor(hex) {
    if (isDefaultInk(hex)) return defaultInk();
    return hex || defaultInk();
  }

  function hexToRgb(hex) {
    const h = (hex || "#ffffff").replace("#", "");
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const n = parseInt(full, 16);
    if (Number.isNaN(n)) return { r: 242, g: 244, b: 248 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbToHex(r, g, b) {
    return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  }

  function colorWithAlpha(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function pencilTint(hex) {
    const { r, g, b } = hexToRgb(hex);
    const mix = 0.42;
    return rgbToHex(r * (1 - mix) + 158 * mix, g * (1 - mix) + 154 * mix, b * (1 - mix) + 146 * mix);
  }

  function normalizeStroke(raw) {
    const t = normalizeTool(raw.tool);
    return {
      tool: t,
      color: raw.color || "#f2f4f8",
      size: Number(raw.size) || 8,
      points: (raw.points || []).map((p) => ({
        x: Number(p.x),
        y: Number(p.y),
        w: p.w == null ? undefined : Number(p.w),
      })),
    };
  }

  function setStrokes(next, updatedAt) {
    strokes = next.map(normalizeStroke);
    lastSavedAt = updatedAt || lastSavedAt;
    rebuildBacking();
    redraw();
  }

  function viewportSize() {
    const host = canvas?.parentElement;
    if (host && host.classList.contains("wb-stage")) {
      const r = host.getBoundingClientRect();
      return {
        w: Math.max(1, Math.floor(r.width)),
        h: Math.max(1, Math.floor(r.height)),
      };
    }
    const vv = window.visualViewport;
    return {
      w: Math.max(1, Math.floor(vv?.width ?? window.innerWidth)),
      h: Math.max(1, Math.floor(vv?.height ?? window.innerHeight)),
    };
  }

  function resizeCanvas() {
    if (!canvas || !ctx) return;
    const { w, h } = viewportSize();
    const dpr = window.devicePixelRatio || 1;
    canvasW = w;
    canvasH = h;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!backing) {
      backing = document.createElement("canvas");
      backingCtx = backing.getContext("2d");
    }
    backing.width = canvas.width;
    backing.height = canvas.height;
    backingCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rebuildBacking();
    redraw();
  }

  function rebuildBacking() {
    if (!backingCtx) return;
    backingCtx.save();
    backingCtx.setTransform(1, 0, 0, 1, 0, 0);
    backingCtx.clearRect(0, 0, backing.width, backing.height);
    backingCtx.restore();
    backingCtx.fillStyle = canvasBg();
    backingCtx.fillRect(0, 0, canvasW, canvasH);
    strokes.forEach((s) => drawStroke(s, backingCtx));
  }

  function endPoint(stroke) {
    const pts = stroke.points;
    return pts[pts.length - 1];
  }

  function drawDot(context, x, y, radius, style) {
    context.fillStyle = style;
    context.beginPath();
    context.arc(x, y, Math.max(0.5, radius), 0, Math.PI * 2);
    context.fill();
  }

  function drawSegmentPath(context, points) {
    context.beginPath();
    points.forEach((p, i) => {
      if (i === 0) context.moveTo(p.x, p.y);
      else context.lineTo(p.x, p.y);
    });
    context.stroke();
  }

  function drawPenStroke(stroke, context, width) {
    const pts = stroke.points;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = colorWithAlpha(stroke.color, 1);
    context.fillStyle = colorWithAlpha(stroke.color, 1);

    if (pts.length === 1) {
      drawDot(context, pts[0].x, pts[0].y, width / 2, context.fillStyle);
      return;
    }

    context.lineWidth = width;
    context.beginPath();
    context.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      context.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    context.quadraticCurveTo(last.x, last.y, last.x, last.y);
    context.stroke();
  }

  function drawMarkerStroke(stroke, context, width) {
    const pts = stroke.points;
    context.globalCompositeOperation = "source-over";
    context.lineJoin = "round";
    context.lineCap = "square";

    if (pts.length === 1) {
      drawDot(context, pts[0].x, pts[0].y, width * 0.45, colorWithAlpha(stroke.color, 0.95));
      return;
    }

    context.shadowBlur = width * 0.55;
    context.shadowColor = colorWithAlpha(stroke.color, 0.4);
    context.lineWidth = width * 1.25;
    context.strokeStyle = colorWithAlpha(stroke.color, 0.45);
    drawSegmentPath(context, pts);
    context.shadowBlur = 0;

    context.lineWidth = width * 0.82;
    context.strokeStyle = colorWithAlpha(stroke.color, 0.97);
    drawSegmentPath(context, pts);

    context.lineWidth = width * 0.55;
    context.strokeStyle = colorWithAlpha(stroke.color, 0.72);
    drawSegmentPath(context, pts);
  }

  function drawPencilStroke(stroke, context, width) {
    const pts = stroke.points;
    const tint = pencilTint(stroke.color);
    context.lineCap = "round";
    context.lineJoin = "round";

    if (pts.length === 1) {
      drawDot(context, pts[0].x, pts[0].y, width * 0.4, colorWithAlpha(tint, 0.5));
      return;
    }

    const passes = [
      { ox: 0, oy: 0, alpha: 0.62, mul: 1 },
      { ox: 0.55, oy: -0.35, alpha: 0.28, mul: 0.55 },
      { ox: -0.45, oy: 0.5, alpha: 0.22, mul: 0.45 },
    ];

    for (const pass of passes) {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const wa = a.w ?? 1;
        const wb = b.w ?? 1;
        const segW = width * ((wa + wb) / 2) * pass.mul;
        context.beginPath();
        context.moveTo(a.x + pass.ox, a.y + pass.oy);
        context.lineTo(b.x + pass.ox, b.y + pass.oy);
        context.lineWidth = Math.max(0.6, segW);
        context.strokeStyle = colorWithAlpha(tint, pass.alpha * ((wa + wb) / 2));
        context.stroke();
      }
    }
  }

  function drawHighlighterStroke(stroke, context, width) {
    const pts = stroke.points;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = width;
    context.strokeStyle = colorWithAlpha(stroke.color, TOOL_DEFS.highlighter.opacity);
    context.fillStyle = context.strokeStyle;

    if (pts.length === 1) {
      drawDot(context, pts[0].x, pts[0].y, width / 2, context.fillStyle);
      return;
    }
    drawSegmentPath(context, pts);
  }

  function drawStroke(stroke, context) {
    if (!stroke.points?.length) return;
    const width = strokeSize(stroke);

    context.save();
    if (stroke.tool === "eraser") {
      context.globalCompositeOperation = "destination-out";
      context.strokeStyle = "rgba(0,0,0,1)";
      context.fillStyle = "rgba(0,0,0,1)";
      context.lineWidth = width;
      context.lineCap = "round";
      context.lineJoin = "round";
      if (stroke.points.length === 1) {
        drawDot(context, stroke.points[0].x, stroke.points[0].y, width / 2, "rgba(0,0,0,1)");
      } else {
        drawSegmentPath(context, stroke.points);
      }
      context.restore();
      return;
    }

    context.globalCompositeOperation = "source-over";
    stroke = { ...stroke, color: strokePaintColor(stroke.color) };

    if (stroke.tool === "line" && stroke.points.length >= 2) {
      const a = stroke.points[0];
      const b = endPoint(stroke);
      context.lineWidth = width;
      context.lineCap = "round";
      context.strokeStyle = colorWithAlpha(stroke.color, 1);
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
    } else if (stroke.tool === "rect" && stroke.points.length >= 2) {
      const a = stroke.points[0];
      const b = endPoint(stroke);
      context.lineWidth = width;
      context.strokeStyle = colorWithAlpha(stroke.color, 1);
      context.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else if (stroke.tool === "circle" && stroke.points.length >= 2) {
      const a = stroke.points[0];
      const b = endPoint(stroke);
      context.lineWidth = width;
      context.strokeStyle = colorWithAlpha(stroke.color, 1);
      context.beginPath();
      context.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      context.stroke();
    } else if (stroke.tool === "pen") {
      drawPenStroke(stroke, context, width);
    } else if (stroke.tool === "marker") {
      drawMarkerStroke(stroke, context, width);
    } else if (stroke.tool === "pencil") {
      drawPencilStroke(stroke, context, width);
    } else if (stroke.tool === "highlighter") {
      drawHighlighterStroke(stroke, context, width);
    } else {
      context.lineWidth = width;
      context.lineCap = "round";
      context.strokeStyle = colorWithAlpha(stroke.color, 1);
      drawSegmentPath(context, stroke.points);
    }
    context.restore();
  }

  function redraw() {
    if (!ctx || !canvas) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (backing) ctx.drawImage(backing, 0, 0);
    ctx.restore();
    if (currentStroke) drawStroke(currentStroke, ctx);
  }

  function scheduleRedraw() {
    if (drawRaf) return;
    drawRaf = requestAnimationFrame(() => {
      drawRaf = 0;
      redraw();
    });
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 700);
  }

  async function saveNow() {
    if (!window.FamilyAPI?.saveWhiteboard) return;
    try {
      const res = await FamilyAPI.saveWhiteboard(strokes);
      lastSavedAt = res.whiteboard?.updatedAt || Date.now();
      localRevision = lastSavedAt;
    } catch (err) {
      console.warn("Whiteboard save failed", err);
    }
  }

  async function pollRemote() {
    if (drawing || !window.FamilyAPI?.getWhiteboard) return;
    if (window.DisplayActive && !window.DisplayActive.isActive()) return;
    try {
      const data = await FamilyAPI.getWhiteboard();
      const remoteAt = data.updatedAt || 0;
      if (remoteAt <= localRevision) return;
      if (remoteAt <= lastSavedAt && strokes.length) return;
      setStrokes(data.strokes || [], remoteAt);
      localRevision = remoteAt;
    } catch {
      /* offline */
    }
  }

  function pointerPos(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: e.clientX - r.left,
      y: e.clientY - r.top,
    };
  }

  function minPointDist() {
    if (tool === "pencil") return 0.8;
    if (tool === "marker") return 0.5;
    return 0.35;
  }

  function addPoint(p) {
    const pts = currentStroke.points;
    const last = pts[pts.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < minPointDist()) return;

    if (currentStroke.tool === "pencil" && last) {
      const speed = Math.hypot(p.x - last.x, p.y - last.y);
      p.w = Math.max(0.3, Math.min(1, 1.15 - speed / 12));
    }

    pts.push(p);
  }

  function notifyKiosk() {
    document.dispatchEvent(new CustomEvent("kiosk-interaction"));
  }

  function onPointerDown(e) {
    if (e.button !== 0 && e.pointerType !== "touch") return;
    e.preventDefault();
    drawing = true;
    notifyKiosk();
    canvas.setPointerCapture(e.pointerId);
    const start = pointerPos(e);
    if (tool === "pencil") start.w = 1;
    currentStroke = {
      tool,
      color: tool === "eraser" ? canvasBg() : color,
      size,
      points: [start],
    };
    scheduleRedraw();
  }

  function onPointerMove(e) {
    if (!drawing || !currentStroke) return;
    e.preventDefault();
    notifyKiosk();
    const events = e.getCoalescedEvents?.() || [e];
    const lastEv = events[events.length - 1];
    if (SHAPE_TOOLS.has(tool)) {
      currentStroke.points = [currentStroke.points[0], pointerPos(lastEv)];
    } else {
      for (const ev of events) addPoint(pointerPos(ev));
    }
    scheduleRedraw();
  }

  function onPointerUp(e) {
    if (!drawing) return;
    drawing = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (currentStroke?.points.length) {
      if (SHAPE_TOOLS.has(currentStroke.tool) && currentStroke.points.length === 1) {
        currentStroke.points.push({ ...currentStroke.points[0] });
      }
      strokes.push(currentStroke);
      localRevision = Date.now();
      drawStroke(currentStroke, backingCtx);
    }
    currentStroke = null;
    redraw();
    scheduleSave();
  }

  function undo() {
    if (!strokes.length) return;
    strokes.pop();
    localRevision = Date.now();
    rebuildBacking();
    redraw();
    scheduleSave();
  }

  function setTool(next) {
    tool = normalizeTool(next);
    document.querySelectorAll("[data-wb-tool]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.wbTool === tool);
    });
  }

  function setColor(value) {
    if (!value) return;
    color = value;
    if (tool === "eraser") setTool("pen");
    updateColorPickerUi();
  }

  function setSize(value) {
    size = value;
    document.querySelectorAll("[data-wb-size]").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.wbSize) === value);
    });
  }

  function updateColorPickerUi() {
    if (!toolbarEl) return;
    const swatch = toolbarEl.querySelector(".wb-color-swatch");
    const input = toolbarEl.querySelector('input[type="color"]');
    if (swatch) swatch.style.background = color;
    if (input && input.value.toLowerCase() !== color.toLowerCase()) input.value = color;
  }

  function buildToolbar(root) {
    toolbarEl = root;
    root.innerHTML = `
      <div class="wb-tools-row wb-main">
        <div class="wb-left">
          <label class="wb-color-picker" title="Pick color">
            <span class="wb-color-swatch" style="background:${color}"></span>
            <input type="color" value="${color}" aria-label="Pick color" />
          </label>
          <span class="wb-color-hint">Tap to change color</span>
        </div>
        <div class="wb-utensils" role="group" aria-label="Drawing tools">
          ${TOOLS.map(
            (t) =>
              `<button type="button" class="wb-utensil${t.id === tool ? " active" : ""}" data-wb-tool="${t.id}" aria-label="${t.label}" title="${t.label}">${t.icon}</button>`
          ).join("")}
        </div>
        <div class="wb-right">
          <div class="wb-actions">
            <button type="button" class="wb-tool" data-wb-action="undo" aria-label="Undo">↩</button>
            <button type="button" class="wb-tool wb-clear" data-wb-action="clear" aria-label="Clear board">🗑</button>
          </div>
          <div class="wb-sizes" role="group" aria-label="Stroke size">
            ${SIZES.map(
              (s) =>
                `<button type="button" class="wb-size${s.value === size ? " active" : ""}" data-wb-size="${s.value}" aria-label="Size ${s.label}"><span style="width:${s.value + 4}px;height:${s.value + 4}px;background:${color}"></span></button>`
            ).join("")}
          </div>
        </div>
      </div>`;

    const colorInput = root.querySelector('input[type="color"]');
    colorInput.addEventListener("input", (e) => {
      e.stopPropagation();
      setColor(e.target.value);
      root.querySelectorAll(".wb-size span").forEach((el) => {
        el.style.background = color;
      });
    });
    colorInput.addEventListener("click", (e) => e.stopPropagation());

    root.querySelectorAll("[data-wb-size]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        setSize(Number(btn.dataset.wbSize));
      });
    });
    root.querySelectorAll("[data-wb-tool]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        setTool(btn.dataset.wbTool);
      });
    });
    root.querySelector('[data-wb-action="undo"]').addEventListener("click", (e) => {
      e.stopPropagation();
      undo();
    });
    root.querySelector('[data-wb-action="clear"]').addEventListener("click", (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      if (!clearArmed) {
        clearArmed = true;
        btn.textContent = "Tap again";
        clearTimer = setTimeout(() => {
          clearArmed = false;
          btn.textContent = "🗑";
        }, 2500);
        return;
      }
      clearArmed = false;
      clearTimeout(clearTimer);
      btn.textContent = "🗑";
      strokes = [];
      currentStroke = null;
      localRevision = Date.now();
      rebuildBacking();
      redraw();
      scheduleSave();
    });
  }

  async function init(opts) {
    canvas = opts.canvas;
    ctx = canvas.getContext("2d");
    document.documentElement.classList.add("wb-page");
    color = defaultInk();
    buildToolbar(opts.toolbar);

    canvas.addEventListener("pointerdown", onPointerDown, { passive: false });
    canvas.addEventListener("pointermove", onPointerMove, { passive: false });
    canvas.addEventListener("pointerup", onPointerUp, { passive: false });
    canvas.addEventListener("pointercancel", onPointerUp, { passive: false });
    canvas.addEventListener("lostpointercapture", onPointerUp);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    window.addEventListener("resize", resizeCanvas);
    window.visualViewport?.addEventListener("resize", resizeCanvas);
    window.addEventListener("orientationchange", () => setTimeout(resizeCanvas, 100));
    resizeCanvas();

    try {
      const data = await FamilyAPI.getWhiteboard();
      setStrokes(data.strokes || [], data.updatedAt || 0);
      localRevision = data.updatedAt || 0;
    } catch (err) {
      console.warn("Whiteboard load failed", err);
    }

    pollTimer = setInterval(pollRemote, 4000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") pollRemote();
    });
    window.addEventListener("message", (e) => {
      if (e.origin !== location.origin) return;
      if (e.data?.type === "fb-kiosk-shown") pollRemote();
    });
    document.addEventListener("kiosk-theme-change", applyThemeColors);
    applyThemeColors();
  }

  function applyThemeColors() {
    if (!canvas || !ctx) return;
    if (isDefaultInk(color)) {
      setColor(defaultInk());
      if (toolbarEl) {
        toolbarEl.querySelectorAll(".wb-size span").forEach((el) => {
          el.style.background = color;
        });
      }
    }
    rebuildBacking();
    redraw();
  }

  function isDrawing() {
    return drawing;
  }

  window.Whiteboard = { init, isDrawing };
})();
