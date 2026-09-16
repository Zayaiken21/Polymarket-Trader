/* BlueEdge chart: real Binance candles (REST history + WebSocket realtime) drawn with TradingView Lightweight Charts. */
window.BlueEdgeChart = (() => {
  const REST = ["https://data-api.binance.vision", "https://api.binance.com", "https://api.binance.us"];
  const WS = ["wss://data-stream.binance.vision/ws", "wss://stream.binance.com:9443/ws", "wss://stream.binance.us:9443/ws"];
  const INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"];
  const PAGE = 1000;
  const HOST_KEY = "blueedge.chartHost";
  const tz = -new Date().getTimezoneOffset() * 60; // show candles in local time

  let restIdx = Number(localStorage.getItem(HOST_KEY)) || 0;
  let chart = null, candles = null, volume = null, host = null, legend = null, statusEl = null;
  let symbol = null, interval = "15m", data = [], loadingOlder = false, reachedStart = false, gen = 0;
  let ws = null, wsIdx = restIdx, wsTimer = null, lastWsMsg = 0, watchdog = null, priceLine = null;
  const precisionCache = {};
  const listeners = [];
  const onUpdate = fn => listeners.push(fn);
  const emit = c => listeners.forEach(fn => { try { fn(c); } catch {} });

  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const setStatus = t => { if (statusEl) { statusEl.textContent = t || ""; statusEl.hidden = !t; } };

  /* ---- REST with host fallback and a small per-minute budget ---- */
  const stamps = [];
  async function rest(path) {
    const now = Date.now();
    while (stamps.length && now - stamps[0] > 60000) stamps.shift();
    if (stamps.length > 60) throw new Error("Chart is loading too fast. Try again in a moment.");
    let lastErr;
    for (let i = 0; i < REST.length; i++) {
      const idx = (restIdx + i) % REST.length;
      stamps.push(Date.now());
      try {
        const res = await fetch(REST[idx] + path, { cache: "no-store" });
        if (res.status === 429 || res.status === 418) throw new Error("Binance is rate limiting. Waiting before loading more.");
        if (res.status === 400) { const j = await res.json().catch(() => ({})); const e = new Error(j.msg || "Bad request"); e.fatal = true; throw e; }
        if (res.status === 451 || res.status === 403) throw new Error("blocked");
        if (!res.ok) throw new Error(`Binance returned ${res.status}`);
        if (idx !== restIdx) { restIdx = idx; localStorage.setItem(HOST_KEY, String(idx)); }
        return res.json();
      } catch (e) { lastErr = e; if (e.fatal) throw e; }
    }
    throw lastErr || new Error("Couldn't reach Binance");
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
      handleScroll: { vertTouchDrag: false }
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
  }

  function fmt(v) { const p = precisionCache[symbol]?.precision ?? 2; return v == null ? "—" : Number(v).toLocaleString("en-US", { minimumFractionDigits: p, maximumFractionDigits: p }); }
  function showLegend(c) {
    if (!legend || !c) return;
    const chg = c.open ? ((c.close - c.open) / c.open) * 100 : 0;
    legend.innerHTML = `<b>${symbol?.replace("USDT", "")}/USDT</b><span>${interval}</span>
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
      openWs(my);
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
  function openWs(my) {
    closeWs();
    const url = `${WS[wsIdx % WS.length]}/${symbol.toLowerCase()}@kline_${interval}`;
    let got = false;
    try { ws = new WebSocket(url); } catch { wsIdx++; wsTimer = setTimeout(() => openWs(my), 2000); return; }
    const sock = ws;
    lastWsMsg = Date.now();
    sock.onmessage = e => {
      if (my !== gen) return;
      got = true; lastWsMsg = Date.now();
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const k = m.k; if (!k) return;
      const c = { time: Math.floor(k.t / 1000) + tz, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
      const last = data[data.length - 1];
      if (last && c.time < last.time) return;
      if (last && c.time === last.time) data[data.length - 1] = c; else data.push(c);
      candles.update(c); volume.update(volBar(c));
      showLegend(c);
      emit(c);
    };
    sock.onclose = () => {
      if (sock !== ws || my !== gen) return;
      if (!got) wsIdx++;
      wsTimer = setTimeout(() => { if (my === gen) resync(my); }, got ? 1500 : 2500);
    };
    sock.onerror = () => {};
    clearInterval(watchdog);
    watchdog = setInterval(() => { if (ws === sock && Date.now() - lastWsMsg > 25000) { try { sock.close(); } catch {} } }, 5000);
  }
  // after a reconnect, refetch the most recent candles so no gap is left on the chart
  async function resync(my) {
    try {
      const rows = await rest(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=50`);
      if (my !== gen) return;
      rows.map(toCandle).forEach(c => {
        const i = data.findIndex(d => d.time === c.time);
        if (i >= 0) data[i] = c; else if (!data.length || c.time > data[data.length - 1].time) data.push(c);
        candles.update(c); volume.update(volBar(c));
      });
    } catch {}
    if (my === gen) openWs(my);
  }
  function closeWs() {
    clearTimeout(wsTimer); clearInterval(watchdog);
    const s = ws; ws = null;
    if (s) { s.onclose = null; try { s.close(); } catch {} }
  }

  /* ---- window-open price line for a Polymarket market ---- */
  function clearPriceLine() { if (priceLine && candles) { try { candles.removePriceLine(priceLine); } catch {} } priceLine = null; }
  function setPriceLine(price, title) {
    clearPriceLine();
    if (!candles || price == null) return;
    priceLine = candles.createPriceLine({ price, color: "#4DA3FF", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: title || "Window open" });
  }

  function pause() { gen++; closeWs(); }
  function resume() { if (symbol && chart) { const s = symbol, iv = interval; symbol = null; load(s, iv); } }

  return { INTERVALS, mount, load, setPriceLine, clearPriceLine, pause, resume, onUpdate, get symbol() { return symbol; }, get interval() { return interval; } };
})();
