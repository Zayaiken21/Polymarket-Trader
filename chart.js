/* BlueEdge chart: real Binance candles (REST history + WebSocket realtime) drawn with TradingView Lightweight Charts.
   Adds: markup/drawing tools (trendline, ray, horizontal line, rectangle, fib retracement, text),
   precise zoom controls, and a touch-friendly mobile toolbar. None of this adds any network calls —
   drawings are pure client-side canvas + localStorage, so the existing Binance rate budget is untouched. */
window.BlueEdgeChart = (() => {
  // Global Binance only (same prices Binance.com shows). Binance.US is a separate, thinner exchange and is never mixed in.
  const REST = ["https://data-api.binance.vision", "https://api.binance.com", "https://api-gcp.binance.com", "https://api1.binance.com", "https://api2.binance.com", "https://api3.binance.com", "https://api4.binance.com"];
  const REST_US = "https://api.binance.us";
  const WS = ["wss://data-stream.binance.vision/ws", "wss://stream.binance.com:9443/ws", "wss://stream.binance.com:443/ws"];
  const INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"];
  const PAGE = 1000;
  try { localStorage.removeItem("blueedge.chartHost"); } catch {} // old builds remembered Binance.US forever
  const tz = -new Date().getTimezoneOffset() * 60; // show candles in local time

  let restIdx = 0, source = "Binance", usingUS = false, pollTimer = null, wsFails = 0;
  let chart = null, candles = null, volume = null, host = null, legend = null, statusEl = null;
  let symbol = null, interval = "15m", data = [], loadingOlder = false, reachedStart = false, gen = 0;
  let ws = null, wsIdx = 0, wsTimer = null, lastWsMsg = 0, watchdog = null, priceLine = null;
  const precisionCache = {};
  const listeners = [];
  const onUpdate = fn => listeners.push(fn);
  const emit = c => listeners.forEach(fn => { try { fn(c); } catch {} });

  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const setStatus = t => { if (statusEl) { statusEl.textContent = t || ""; statusEl.hidden = !t; } };

  /* ---- REST with host fallback and a small per-minute budget ---- */
  const stamps = [];
  async function tryHost(base, path) {
    const res = await fetch(base + path, { cache: "no-store" });
    if (res.status === 429 || res.status === 418) { const e = new Error("Binance is rate limiting. Waiting a moment."); e.rate = true; throw e; }
    if (res.status === 400) { const j = await res.json().catch(() => ({})); const e = new Error(j.msg || "Bad request"); e.fatal = true; throw e; }
    if (!res.ok) throw new Error(`Binance returned ${res.status}`);
    return res.json();
  }
  async function rest(path) {
    const now = Date.now();
    while (stamps.length && now - stamps[0] > 60000) stamps.shift();
    if (stamps.length > 90) throw new Error("Chart is loading too fast. Try again in a moment.");
    stamps.push(now);
    let lastErr;
    for (let i = 0; i < REST.length; i++) {
      const idx = (restIdx + i) % REST.length;
      try { const j = await tryHost(REST[idx], path); restIdx = idx; if (usingUS) { usingUS = false; source = "Binance"; } return j; }
      catch (e) { lastErr = e; if (e.fatal || e.rate) throw e; }
    }
    // every global Binance host is unreachable from this network: last resort, clearly labelled
    try { const j = await tryHost(REST_US, path); usingUS = true; source = "Binance.US (global Binance blocked on this network)"; return j; }
    catch (e) { throw lastErr || e; }
  }

  const toCandle = k => ({ time: Math.floor(k[0] / 1000) + tz, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });

  async function precisionFor(sym, sample) {
    if (precisionCache[sym]) return precisionCache[sym];
    let tick = null;
    try {
      const info = await rest(`/api/v3/exchangeInfo?symbol=${sym}`);
      tick = info?.symbols?.[0]?.filters?.find(f => f.filterType === "PRICE_FILTER")?.tickSize;
    } catch {}
    let decimals;
    if (tick) decimals = Math.max(0, (String(+tick).split(".")[1] || "").length);
    else decimals = sample >= 1000 ? 2 : sample >= 10 ? 3 : sample >= 1 ? 4 : 6;
    precisionCache[sym] = { precision: decimals, minMove: +(1 / 10 ** decimals).toFixed(decimals) };
    return precisionCache[sym];
  }

  /* ==================== Drawing & markup tools ==================== */
  const DRAW_COLORS = ["#4DA3FF", "#FFB13D", "#FF6F7D", "#2ECF8E", "#C792EA", "#F5F7FA"];
  const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  let tool = "cursor", drawColor = DRAW_COLORS[0], drawWidth = 2;
  let drawings = [], selectedId = null, draft = null, hoverPt = null;
  let dragHandle = null; // { id, index } while dragging an existing point
  let uiRoot = null, toolbarEl = null, colorBtn = null, widthBtn = null;
  let drawPrimitive = null;

  function uid() { return Math.random().toString(36).slice(2, 9); }
  const storeKey = () => `blueedge.drawings.${symbol}`;
  function saveDrawings() { try { localStorage.setItem(storeKey(), JSON.stringify(drawings)); } catch {} }
  function loadDrawingsFor(sym) {
    drawings = []; selectedId = null; draft = null;
    try { drawings = JSON.parse(localStorage.getItem(`blueedge.drawings.${sym}`) || "[]") || []; } catch { drawings = []; }
    refreshPrimitive();
  }

  function X(time) { return chart?.timeScale().timeToCoordinate(time); }
  function Y(price) { return candles?.priceToCoordinate(price); }
  function toTime(x) { return chart?.timeScale().coordinateToTime(x); }
  function toPrice(y) { return candles?.coordinateToPrice(y); }

  function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  function hitTest(px, py) {
    for (let i = drawings.length - 1; i >= 0; i--) {
      const d = drawings[i];
      const pts = d.points.map(p => ({ x: X(p.time), y: Y(p.price) })).filter(p => p.x != null && p.y != null);
      if (pts.length < 1) continue;
      if (d.type === "hline") { if (Math.abs(py - pts[0].y) < 6) return d; }
      else if (d.type === "ray") { const w = host.clientWidth; if (distToSeg(px, py, pts[0].x, pts[0].y, w, pts[0].y + (pts[1] ? (pts[1].y - pts[0].y) : 0)) < 6) return d; }
      else if (d.type === "trend") { if (pts[1] && distToSeg(px, py, pts[0].x, pts[0].y, pts[1].x, pts[1].y) < 6) return d; }
      else if (d.type === "rect" || d.type === "fib") {
        if (!pts[1]) continue;
        const x0 = Math.min(pts[0].x, pts[1].x), x1 = Math.max(pts[0].x, pts[1].x);
        const y0 = Math.min(pts[0].y, pts[1].y), y1 = Math.max(pts[0].y, pts[1].y);
        if (px >= x0 - 4 && px <= x1 + 4 && py >= y0 - 4 && py <= y1 + 4) return d;
      } else if (d.type === "text") {
        if (Math.hypot(px - pts[0].x, py - pts[0].y - 8) < 16) return d;
      }
    }
    return null;
  }

  function handleAt(px, py) {
    if (!selectedId) return null;
    const d = drawings.find(dd => dd.id === selectedId);
    if (!d) return null;
    for (let i = 0; i < d.points.length; i++) {
      const p = d.points[i];
      const x = X(p.time), y = Y(p.price);
      if (x == null || y == null) continue;
      if (Math.hypot(px - x, py - y) < 12) return { id: d.id, index: i };
    }
    return null;
  }

  function commit(d) { drawings.push(d); saveDrawings(); refreshPrimitive(); }
  function undo() { drawings.pop(); saveDrawings(); refreshPrimitive(); }
  function clearAll() { if (!drawings.length) return; drawings = []; selectedId = null; saveDrawings(); refreshPrimitive(); }
  function removeDrawing(id) { drawings = drawings.filter(d => d.id !== id); if (selectedId === id) selectedId = null; saveDrawings(); refreshPrimitive(); }

  function setChartInteractive(on) {
    chart?.applyOptions({ handleScroll: on ? { vertTouchDrag: false } : false, handleScale: on });
  }

  /* ---- pointer interaction, mouse + touch via Pointer Events ---- */
  function relPoint(e) {
    const r = host.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onPointerDown(e) {
    if (!chart) return;
    const { x, y } = relPoint(e);
    if (tool === "eraser") { const hit = hitTest(x, y); if (hit) removeDrawing(hit.id); return; }
    if (tool === "cursor") {
      const h = handleAt(x, y);
      if (h) { dragHandle = h; setChartInteractive(false); e.preventDefault?.(); host.setPointerCapture?.(e.pointerId); return; }
      const hit = hitTest(x, y);
      selectedId = hit ? hit.id : null;
      refreshPrimitive();
      return;
    }
    if (tool === "text") {
      const time = toTime(x), price = toPrice(y);
      if (time == null || price == null) return;
      openTextInput(x, y, time, price);
      return;
    }
    if (tool === "hline") {
      const price = toPrice(y);
      if (price == null) return;
      commit({ id: uid(), type: "hline", color: drawColor, width: drawWidth, points: [{ time: data[0]?.time ?? 0, price }] });
      setTool("cursor");
      return;
    }
    // two-click shapes: trend, ray, rect, fib
    const time = toTime(x), price = toPrice(y);
    if (time == null || price == null) return;
    if (!draft) {
      draft = { id: uid(), type: tool, color: drawColor, width: drawWidth, points: [{ time, price }] };
    } else {
      draft.points.push({ time, price });
      commit(draft);
      draft = null; hoverPt = null;
      setTool("cursor");
    }
  }
  function onPointerMove(e) {
    if (!chart) return;
    const { x, y } = relPoint(e);
    if (dragHandle) {
      const time = toTime(x), price = toPrice(y);
      if (time != null && price != null) {
        const d = drawings.find(dd => dd.id === dragHandle.id);
        if (d) { d.points[dragHandle.index] = { time, price }; refreshPrimitive(); }
      }
      return;
    }
    if (draft) {
      const time = toTime(x), price = toPrice(y);
      if (time != null && price != null) { hoverPt = { time, price }; refreshPrimitive(); }
    }
  }
  function onPointerUp() {
    if (dragHandle) { dragHandle = null; setChartInteractive(true); saveDrawings(); }
  }
  function onDblClick() {
    if (draft) { draft = null; hoverPt = null; refreshPrimitive(); return; }
    if (!selectedId) chart.timeScale().fitContent();
  }
  function onKeyDown(e) {
    if (e.key === "Escape") { draft = null; hoverPt = null; selectedId = null; setTool("cursor"); }
    if ((e.key === "Delete" || e.key === "Backspace") && selectedId && document.activeElement === document.body) { removeDrawing(selectedId); }
  }

  function openTextInput(x, y, time, price) {
    const box = document.createElement("div");
    box.contentEditable = "true";
    box.className = "be-text-input";
    box.style.left = x + "px"; box.style.top = Math.max(0, y - 10) + "px"; box.style.color = drawColor;
    uiRoot.appendChild(box);
    box.focus();
    const finish = () => {
      const txt = box.textContent.trim();
      box.remove();
      if (txt) commit({ id: uid(), type: "text", color: drawColor, width: drawWidth, text: txt, points: [{ time, price }] });
      setTool("cursor");
    };
    box.addEventListener("blur", finish, { once: true });
    box.addEventListener("keydown", ev => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); box.blur(); } if (ev.key === "Escape") { box.textContent = ""; box.blur(); } });
  }

  /* ---- rendering via Lightweight Charts v5 primitive API ---- */
  class DrawingsPrimitive {
    paneViews() { return [{ renderer: () => ({ draw: target => target.useMediaCoordinateSpace(({ context, mediaSize }) => renderAll(context, mediaSize)) }) }]; }
    updateAllViews() {}
  }
  function refreshPrimitive() { drawPrimitive?.applyOptions?.(); chart && requestAnimationFrame(() => chart.timeScale().applyOptions({})); }

  function strokeStyle(ctx, color, width, dashed) {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dashed ? [6, 4] : []);
  }
  function renderAll(ctx, size) {
    const all = draft ? [...drawings, { ...draft, points: hoverPt ? [...draft.points, hoverPt] : draft.points, ghost: true }] : drawings;
    for (const d of all) renderOne(ctx, size, d);
  }
  function renderOne(ctx, size, d) {
    const pts = d.points.map(p => ({ x: X(p.time), y: Y(p.price) }));
    if (pts.some(p => p.x == null || p.y == null)) return;
    const isSel = d.id === selectedId;
    ctx.save();
    strokeStyle(ctx, d.color, d.width + (isSel ? 1 : 0), d.ghost);
    ctx.globalAlpha = d.ghost ? 0.75 : 1;
    if (d.type === "hline") {
      ctx.beginPath(); ctx.moveTo(0, pts[0].y); ctx.lineTo(size.width, pts[0].y); ctx.stroke();
      label(ctx, d, size.width - 4, pts[0].y - 6, "right");
    } else if (d.type === "ray") {
      const p1 = pts[1] || pts[0];
      const dx = p1.x - pts[0].x, dy = p1.y - pts[0].y;
      const ext = dx === 0 ? 0 : (size.width - pts[0].x) / (dx || 1);
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(dx === 0 ? pts[0].x : size.width, dx === 0 ? size.height : pts[0].y + dy * Math.max(ext, 1)); ctx.stroke();
    } else if (d.type === "trend") {
      if (pts[1]) { ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke(); }
    } else if (d.type === "rect") {
      if (pts[1]) {
        const x0 = Math.min(pts[0].x, pts[1].x), y0 = Math.min(pts[0].y, pts[1].y);
        const w = Math.abs(pts[1].x - pts[0].x), h = Math.abs(pts[1].y - pts[0].y);
        ctx.fillStyle = d.color + "26"; ctx.fillRect(x0, y0, w, h); ctx.strokeRect(x0, y0, w, h);
      }
    } else if (d.type === "fib") {
      if (pts[1]) {
        const x0 = Math.min(pts[0].x, pts[1].x), x1 = Math.max(pts[0].x, pts[1].x);
        const p0 = d.points[0].price, p1 = d.points[1].price;
        for (const lvl of FIB_LEVELS) {
          const price = p0 + (p1 - p0) * lvl;
          const y = Y(price); if (y == null) continue;
          ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
          ctx.font = "11px sans-serif"; ctx.fillStyle = d.color;
          ctx.fillText(`${(lvl * 100).toFixed(1)}%`, x0 + 4, y - 3);
        }
      }
    } else if (d.type === "text") {
      ctx.font = "600 13px sans-serif"; ctx.fillStyle = d.color; ctx.fillText(d.text, pts[0].x, pts[0].y);
    }
    if (isSel) {
      ctx.setLineDash([]); ctx.fillStyle = d.color;
      for (const p of pts) { ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, 7); ctx.fill(); ctx.strokeStyle = "#0008"; ctx.lineWidth = 1.5; ctx.stroke(); }
    }
    ctx.restore();
  }
  function label(ctx, d, x, y, align) {
    ctx.font = "11px sans-serif"; ctx.fillStyle = d.color; ctx.textAlign = align; ctx.fillText(d.points[0].price?.toFixed?.(4) ?? "", x, y); ctx.textAlign = "left";
  }

  /* ---- toolbar UI (works with mouse and touch, scrolls horizontally on narrow screens) ---- */
  const TOOL_DEFS = [
    ["cursor", "M4 3l14 6-6 2-2 6-6-14z", "Select / pan"],
    ["trend", "M3 17L17 3", "Trend line"],
    ["ray", "M3 17L17 3M17 3v6M17 3h-6", "Ray"],
    ["hline", "M3 10h14", "Horizontal line"],
    ["rect", "M3 4h14v12H3z", "Rectangle"],
    ["fib", "M3 4h14M3 8h10M3 12h14M3 16h6", "Fib retracement"],
    ["text", "M4 4h12M10 4v12", "Text note"],
    ["eraser", "M4 13l6-6 6 6-4 4H8z", "Erase (tap a drawing)"]
  ];
  function injectStyle() {
    if (document.getElementById("be-chart-tools-style")) return;
    const s = document.createElement("style"); s.id = "be-chart-tools-style";
    // Every rule is scoped under the be- prefix (never a bare class like ".side" or ".active")
    // and box/layout properties are !important, because this toolbar is injected into a host
    // page whose own stylesheet we don't control and must never be shadowed or reshaped by it.
    s.textContent = `
      .be-toolbar, .be-toolbar *{box-sizing:border-box !important}
      .be-toolbar{position:absolute !important;z-index:5;display:flex !important;gap:4px;padding:5px;
        border-radius:var(--radius,12px);background:var(--panel,#0E223B);background:rgba(12,20,30,.86);
        backdrop-filter:blur(8px);border:1px solid var(--line-soft,rgba(120,160,200,.18));
        box-shadow:0 4px 16px rgba(0,0,0,.35);align-items:center !important;max-width:calc(100% - 12px)}
      .be-toolbar.be-rail{flex-direction:column !important;right:10px;top:10px;left:auto;bottom:auto;
        max-height:calc(100% - 20px);overflow-y:auto;overscroll-behavior:contain}
      .be-toolbar.be-dock{flex-direction:row !important;left:6px;right:6px;top:auto;
        bottom:calc(8px + var(--safe-b,0px));overflow-x:auto;-webkit-overflow-scrolling:touch;
        justify-content:flex-start !important;max-width:calc(100% - 12px)}
      .be-toolbar button{all:unset;box-sizing:border-box !important;width:32px !important;height:32px !important;
        min-width:32px !important;min-height:32px !important;flex:0 0 auto !important;display:flex !important;
        align-items:center !important;justify-content:center !important;border-radius:8px;color:var(--muted,#8BA4BF);
        cursor:pointer;touch-action:manipulation}
      .be-toolbar.be-dock button{width:38px !important;height:38px !important;min-width:38px !important;min-height:38px !important}
      .be-toolbar button svg{width:16px;height:16px;pointer-events:none;flex:none}
      .be-toolbar button:active{background:rgba(120,160,200,.18)}
      .be-toolbar button.be-active{background:var(--accent,#4DA3FF);color:var(--accent-ink,#08131f)}
      .be-toolbar .be-sep{flex:0 0 auto !important;width:1px;align-self:stretch;background:rgba(120,160,200,.22);margin:2px}
      .be-toolbar.be-dock .be-sep{width:0;height:0;margin:0;display:none}
      .be-swatch{display:block;width:16px;height:16px;border-radius:50%;border:2px solid rgba(255,255,255,.55)}
      .be-text-input{position:absolute;z-index:6;min-width:40px;outline:none;font:600 13px sans-serif;
        background:rgba(12,20,30,.75);border:1px dashed currentColor;border-radius:4px;padding:1px 4px}
    `;
    document.head.appendChild(s);
  }
  let layoutMq = null;
  function applyLayout() {
    if (!toolbarEl) return;
    const dock = layoutMq ? layoutMq.matches : window.innerWidth <= 640;
    toolbarEl.classList.toggle("be-dock", dock);
    toolbarEl.classList.toggle("be-rail", !dock);
  }
  function icon(path) { return `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`; }

  function buildToolbar() {
    toolbarEl = document.createElement("div");
    toolbarEl.className = "be-toolbar";
    const mkBtn = (title, html, onClick) => {
      const b = document.createElement("button"); b.title = title; b.innerHTML = html;
      b.addEventListener("click", ev => { ev.stopPropagation(); onClick(); });
      toolbarEl.appendChild(b); return b;
    };
    for (const [id, path, title] of TOOL_DEFS) {
      const b = mkBtn(title, icon(path), () => setTool(id));
      b.dataset.tool = id;
    }
    const sep1 = document.createElement("div"); sep1.className = "be-sep"; toolbarEl.appendChild(sep1);
    colorBtn = mkBtn("Color", `<span class="be-swatch" style="background:${drawColor}"></span>`, () => {
      const i = (DRAW_COLORS.indexOf(drawColor) + 1) % DRAW_COLORS.length;
      drawColor = DRAW_COLORS[i];
      colorBtn.querySelector(".be-swatch").style.background = drawColor;
      if (selectedId) { const d = drawings.find(x => x.id === selectedId); if (d) { d.color = drawColor; saveDrawings(); refreshPrimitive(); } }
    });
    widthBtn = mkBtn("Line width", "2px", () => {
      drawWidth = drawWidth === 2 ? 3 : drawWidth === 3 ? 1 : 2;
      widthBtn.textContent = drawWidth + "px";
      if (selectedId) { const d = drawings.find(x => x.id === selectedId); if (d) { d.width = drawWidth; saveDrawings(); refreshPrimitive(); } }
    });
    const sep2 = document.createElement("div"); sep2.className = "be-sep"; toolbarEl.appendChild(sep2);
    mkBtn("Delete selected", icon("M5 6h10M8 6V4h4v2M6 6l1 10h6l1-10"), () => { if (selectedId) removeDrawing(selectedId); });
    mkBtn("Undo last", icon("M6 8L3 5l3-3M3 5h9a5 5 0 010 10H8"), undo);
    mkBtn("Clear all", icon("M4 5h12M7 5V3h6v2M5 5l1 12h8l1-12"), () => { if (drawings.length && confirm("Clear all drawings on this chart?")) clearAll(); });
    const sep3 = document.createElement("div"); sep3.className = "be-sep"; toolbarEl.appendChild(sep3);
    mkBtn("Zoom in", icon("M9 4v10M4 9h10"), () => zoomBy(0.8));
    mkBtn("Zoom out", icon("M4 9h10"), () => zoomBy(1.25));
    mkBtn("Fit chart", icon("M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4"), () => chart.timeScale().fitContent());
    uiRoot.appendChild(toolbarEl);
    markActive();
  }
  function markActive() { toolbarEl?.querySelectorAll("button[data-tool]").forEach(b => b.classList.toggle("be-active", b.dataset.tool === tool)); }
  function setTool(t) {
    if (tool !== t) { draft = null; hoverPt = null; }
    if (t !== "cursor") selectedId = null;
    tool = t; markActive(); refreshPrimitive();
    if (host) host.style.cursor = t === "cursor" ? "default" : "crosshair";
  }
  function zoomBy(factor) {
    const r = chart?.timeScale().getVisibleLogicalRange();
    if (!r) return;
    const mid = (r.from + r.to) / 2, half = ((r.to - r.from) / 2) * factor;
    chart.timeScale().setVisibleLogicalRange({ from: mid - half, to: mid + half });
  }

  /* ---- chart ---- */
  function mount(el, legendEl, statusElement) {
    host = el; legend = legendEl; statusEl = statusElement;
    if (!window.LightweightCharts) { setStatus("Chart library didn't load."); return; }
    const LC = window.LightweightCharts;
    chart = LC.createChart(el, {
      autoSize: true,
      layout: { background: { type: "solid", color: "transparent" }, textColor: css("--muted") || "#8BA4BF", fontFamily: getComputedStyle(document.body).fontFamily, attributionLogo: true },
      grid: { vertLines: { color: "rgba(120,160,200,.07)" }, horzLines: { color: "rgba(120,160,200,.07)" } },
      rightPriceScale: { borderColor: "rgba(120,160,200,.18)" },
      timeScale: { borderColor: "rgba(120,160,200,.18)", timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: LC.CrosshairMode.Normal },
      handleScroll: { vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
    });
    candles = chart.addSeries(LC.CandlestickSeries, { upColor: "#2ECF8E", downColor: "#FF6F7D", borderVisible: false, wickUpColor: "#2ECF8E", wickDownColor: "#FF6F7D" });
    volume = chart.addSeries(LC.HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } });

    chart.timeScale().subscribeVisibleLogicalRangeChange(range => { if (range && range.from < 30) loadOlder(); });
    chart.subscribeCrosshairMove(p => {
      const c = p?.seriesData?.get(candles);
      showLegend(c ? { ...c, volume: data.find(d => d.time === c.time)?.volume } : data[data.length - 1]);
    });

    // ---- markup tools + mobile-friendly UI wiring ----
    injectStyle();
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    // Deliberately NOT touching el's touch-action: the host page sets it to "none" on the chart
    // host so the library (and our own pointer handlers) get raw, unhijacked touch gestures for
    // pan/pinch/drawing. Overriding it here previously fought that and broke mobile gestures.
    uiRoot = el;
    try { drawPrimitive = new DrawingsPrimitive(); candles.attachPrimitive(drawPrimitive); } catch {}
    buildToolbar();
    if (!layoutMq && window.matchMedia) {
      layoutMq = window.matchMedia("(max-width: 640px)");
      const onChange = () => applyLayout();
      layoutMq.addEventListener ? layoutMq.addEventListener("change", onChange) : layoutMq.addListener(onChange);
    }
    applyLayout();
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    chart.subscribeDblClick(onDblClick);
    document.addEventListener("keydown", onKeyDown);
    setTool("cursor");
  }

  const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function fmt(v) { const p = precisionCache[symbol]?.precision ?? 2; return v == null ? "—" : Number(v).toLocaleString("en-US", { minimumFractionDigits: p, maximumFractionDigits: p }); }
  function showLegend(c) {
    if (!legend || !c) return;
    const chg = c.open ? ((c.close - c.open) / c.open) * 100 : 0;
    legend.innerHTML = `<b>${symbol?.replace("USDT", "")}/USDT</b><span>${interval}</span><span class="src ${usingUS ? "warn" : ""}">${esc(source)}${ws && ws.readyState === 1 ? " live" : pollTimer ? " (REST updates)" : ""}</span>
      <span>O <em>${fmt(c.open)}</em></span><span>H <em>${fmt(c.high)}</em></span><span>L <em>${fmt(c.low)}</em></span><span>C <em>${fmt(c.close)}</em></span>
      <span class="${chg >= 0 ? "gain" : "loss"}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</span>`;
  }

  const volBar = c => ({ time: c.time, value: c.volume, color: c.close >= c.open ? "rgba(46,207,142,.35)" : "rgba(255,111,125,.35)" });

  async function load(sym, iv) {
    if (!chart) return;
    sym = String(sym || "BTC").toUpperCase().replace(/USDT$/, "") + "USDT";
    iv = INTERVALS.includes(iv) ? iv : "15m";
    if (sym === symbol && iv === interval) return;
    const my = ++gen;
    symbol = sym; interval = iv; data = []; reachedStart = false;
    closeWs();
    clearPriceLine();
    candles.setData([]); volume.setData([]);
    loadDrawingsFor(sym);
    setStatus(`Loading ${sym.replace("USDT", "")} ${iv} candles from Binance…`);
    try {
      const rows = await rest(`/api/v3/klines?symbol=${sym}&interval=${iv}&limit=${PAGE}`);
      if (my !== gen) return;
      if (!Array.isArray(rows) || !rows.length) throw new Error(`Binance has no ${sym} data.`);
      data = rows.map(toCandle);
      reachedStart = rows.length < PAGE;
      const pf = await precisionFor(sym, data[data.length - 1].close);
      if (my !== gen) return;
      candles.applyOptions({ priceFormat: { type: "price", precision: pf.precision, minMove: pf.minMove } });
      candles.setData(data);
      volume.setData(data.map(volBar));
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, data.length - 120), to: data.length + 5 });
      showLegend(data[data.length - 1]);
      setStatus("");
      startRealtime(my);
    } catch (e) {
      if (my !== gen) return;
      setStatus(e.fatal ? `Binance doesn't list ${sym.replace("USDT", "")}/USDT.` : `Couldn't load candles: ${e.message}`);
    }
  }

  async function loadOlder() {
    if (loadingOlder || reachedStart || !data.length) return;
    loadingOlder = true;
    const my = gen;
    try {
      const rows = await rest(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${PAGE}&endTime=${(data[0].time - tz) * 1000 - 1}`);
      if (my !== gen) return;
      if (!rows.length) { reachedStart = true; return; }
      const older = rows.map(toCandle).filter(c => c.time < data[0].time);
      if (rows.length < PAGE) reachedStart = true;
      if (!older.length) return;
      const range = chart.timeScale().getVisibleLogicalRange();
      data = [...older, ...data];
      candles.setData(data);
      volume.setData(data.map(volBar));
      if (range) chart.timeScale().setVisibleLogicalRange({ from: range.from + older.length, to: range.to + older.length });
    } catch (e) { console.warn("Older candles failed", e.message); }
    finally { setTimeout(() => { loadingOlder = false; }, 400); }
  }

  /* ---- realtime ---- */
  function applyCandle(c) {
    const last = data[data.length - 1];
    if (last && c.time < last.time) return;
    if (last && c.time === last.time) data[data.length - 1] = c; else data.push(c);
    candles.update(c); volume.update(volBar(c));
    emit(c);
  }
  function startRealtime(my) {
    stopRealtime();
    if (usingUS || wsFails >= WS.length * 2) return startPolling(my); // keep the feed consistent with the history source
    openWs(my);
  }
  function openWs(my) {
    const url = `${WS[wsIdx % WS.length]}/${symbol.toLowerCase()}@kline_${interval}`;
    let got = false, sock;
    try { sock = new WebSocket(url); } catch { wsFails++; wsIdx++; wsTimer = setTimeout(() => startRealtime(my), 1500); return; }
    ws = sock; lastWsMsg = Date.now();
    const probe = setTimeout(() => { if (!got) try { sock.close(); } catch {} }, 8000);
    sock.onmessage = e => {
      if (my !== gen) return;
      if (!got) { got = true; wsFails = 0; clearTimeout(probe); showLegend(data[data.length - 1]); }
      lastWsMsg = Date.now();
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const k = m.k; if (!k) return;
      const c = { time: Math.floor(k.t / 1000) + tz, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
      applyCandle(c); showLegend(c);
    };
    sock.onclose = () => {
      clearTimeout(probe);
      if (sock !== ws || my !== gen) return;
      if (!got) { wsFails++; wsIdx++; }
      wsTimer = setTimeout(() => { if (my === gen) resync(my); }, got ? 1500 : 800);
    };
    sock.onerror = () => {};
    clearInterval(watchdog);
    watchdog = setInterval(() => { if (ws === sock && Date.now() - lastWsMsg > 25000) { try { sock.close(); } catch {} } }, 5000);
  }
  function startPolling(my) {
    clearInterval(pollTimer);
    const tickMs = ["1m", "3m"].includes(interval) ? 3000 : 5000;
    const poll = async () => {
      if (my !== gen || document.hidden) return;
      try { (await rest(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=2`)).map(toCandle).forEach(c => { applyCandle(c); showLegend(c); }); } catch {}
    };
    pollTimer = setInterval(poll, tickMs); poll();
    // try the WebSocket again every 2 minutes
    wsTimer = setTimeout(() => { if (my === gen && !usingUS) { wsFails = 0; startRealtime(my); } }, 120000);
  }
  // after a reconnect, refetch the latest candles so no gap is left, then reopen realtime
  async function resync(my) {
    try { (await rest(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=50`)).map(toCandle).forEach(c => { const i = data.findIndex(d => d.time === c.time); if (i >= 0) { data[i] = c; candles.update(c); volume.update(volBar(c)); } else applyCandle(c); }); } catch {}
    if (my === gen) startRealtime(my);
  }
  function stopRealtime() {
    clearTimeout(wsTimer); clearInterval(watchdog); clearInterval(pollTimer); pollTimer = null;
    const s0 = ws; ws = null;
    if (s0) { s0.onclose = null; try { s0.close(); } catch {} }
  }
  const closeWs = stopRealtime;

  /* ---- window-open price line for a Polymarket market ---- */
  function clearPriceLine() { if (priceLine && candles) { try { candles.removePriceLine(priceLine); } catch {} } priceLine = null; }
  function setPriceLine(price, title, estimate) {
    clearPriceLine();
    if (!candles || price == null) return;
    priceLine = candles.createPriceLine({
      price,
      color: estimate ? "#4DA3FF99" : "#4DA3FF",
      lineWidth: 1,
      lineStyle: estimate ? 3 : 2, // 3 = LargeDashed for an estimate, 2 = Dashed for the confirmed price
      axisLabelVisible: true,
      title: title || "Window open"
    });
  }

  function pause() { gen++; closeWs(); }
  function resume() { if (symbol && chart) { const s = symbol, iv = interval; symbol = null; load(s, iv); } }

  return {
    INTERVALS, mount, load, setPriceLine, clearPriceLine, pause, resume, onUpdate,
    get symbol() { return symbol; }, get interval() { return interval; },
    // markup & zoom controls (also reachable via the on-chart toolbar)
    setTool, clearDrawings: clearAll, undoDrawing: undo, zoomIn: () => zoomBy(0.8), zoomOut: () => zoomBy(1.25),
    fitContent: () => chart?.timeScale().fitContent()
  };
})();
