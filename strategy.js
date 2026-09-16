/* BlueEdge strategy: you choose timeframes and stake. Entry rules are fixed and shown in the app. */
window.BlueEdgeStrategy = (() => {
  const KEY = "blueedge.strategy.v3";
  const RULES = Object.freeze({ minPrice: 0.35, maxPrice: 0.75, maxSpread: 0.03, skipFirst: 30, stopBefore: 60, maxOpen: 3, slippage: 0.02 });
  const defaults = { timeframes: [5, 15, 60], risk: { mode: "pct", pct: 1, usd: 10 } };
  const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const round2 = n => Math.round(n * 100) / 100;

  function sanitize(s) {
    const o = { ...defaults, ...s };
    o.timeframes = [...new Set((Array.isArray(o.timeframes) ? o.timeframes : defaults.timeframes).map(Number))].filter(t => [5, 15, 60].includes(t)).sort((a, b) => a - b);
    o.risk = { mode: o.risk?.mode === "usd" ? "usd" : "pct", pct: clamp(o.risk?.pct, 0, 100, 1), usd: clamp(o.risk?.usd, 0, 1e9, 10) };
    return { timeframes: o.timeframes, risk: o.risk };
  }
  function load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY) || "null"); } catch {}
    if (!s) { try { const v2 = JSON.parse(localStorage.getItem("blueedge.strategy.v2") || "null"); if (v2) s = { timeframes: v2.timeframes, risk: v2.risk }; } catch {} }
    return sanitize(s || {});
  }
  const save = s => localStorage.setItem(KEY, JSON.stringify(sanitize(s)));

  function sync(obj, base) {
    const b = Math.max(0, Number(base) || 0);
    if (obj.mode === "pct") obj.usd = round2(b * obj.pct / 100);
    else obj.pct = b > 0 ? round2(obj.usd / b * 100) : 0;
    return obj;
  }
  function setMoney(obj, field, value, base) { obj.mode = field === "usd" ? "usd" : "pct"; obj[obj.mode] = Math.max(0, Number(value) || 0); return sync(obj, base); }
  const stake = (s, equity) => (s.risk.mode === "pct" ? equity * s.risk.pct / 100 : s.risk.usd);
  const fee = (shares, price, rate) => Math.max(0, shares * (rate || 0) * price * (1 - price));

  const cents = p => p == null ? "—" : (Math.abs(p * 100 - Math.round(p * 100)) > 0.05 ? (p * 100).toFixed(1) : Math.round(p * 100)) + "¢";
  const secs = s => { s = Math.max(0, Math.round(s)); return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`; };
  const tfName = tf => (tf === 60 ? "1 hour" : `${tf} min`);

  /* ctx = { now, up:{bid,ask}, down:{bid,ask}, open, spot } */
  function evaluate(s, m, ctx) {
    const R = RULES, now = ctx.now;
    const elapsed = (now - m.start) / 1000, left = (m.end - now) / 1000;
    const done = reason => ({ ok: false, side: null, price: null, checks: [], reason });
    if (!s.timeframes.includes(m.tf)) return done(`${tfName(m.tf)} markets are off`);
    if (left <= 0) return done("Window closed");
    if (elapsed < 0) return done(`Opens in ${secs(-elapsed)}`);
    if (ctx.open == null || ctx.spot == null) return done("Waiting for the Binance window open");
    if (ctx.spot === ctx.open) return done("Binance is flat vs. the window open");
    const side = ctx.spot > ctx.open ? "Up" : "Down";
    const book = side === "Up" ? ctx.up : ctx.down;
    const ask = book.ask, bid = book.bid;
    const checks = [];
    const add = (label, pass, why) => checks.push({ label, pass, why });
    add(`Binance is ${side === "Up" ? "above" : "below"} the window open`, true, "");
    add(`At least ${secs(R.skipFirst)} into the window`, elapsed >= R.skipFirst, `Entries open in ${secs(R.skipFirst - elapsed)}`);
    add(`At least ${secs(R.stopBefore)} left`, left >= R.stopBefore, "Too close to the close for new entries");
    add(`${side} costs ${cents(R.minPrice)}–${cents(R.maxPrice)}`, ask != null && ask >= R.minPrice && ask <= R.maxPrice,
      ask == null ? `No ${side} sellers right now` : `${side} is ${cents(ask)}, outside ${cents(R.minPrice)}–${cents(R.maxPrice)}`);
    add(`Spread ${cents(R.maxSpread)} or tighter`, ask != null && bid != null && ask - bid <= R.maxSpread + 1e-9,
      ask != null && bid != null ? `Spread is ${cents(ask - bid)}` : "Order book is one-sided");
    add("Accepting orders", m.accepting !== false, "Polymarket isn't accepting orders");
    const fail = checks.find(c => !c.pass);
    return { ok: !fail, side, price: ask, checks, reason: fail ? fail.why : `Ready: buy ${side} at ${cents(ask)}` };
  }

  const rulesText = () => [
    `Buys the side Binance is moving toward since the window opened.`,
    `Only enters ${secs(RULES.skipFirst)} after a window opens and stops with ${secs(RULES.stopBefore)} left.`,
    `Only pays ${cents(RULES.minPrice)}–${cents(RULES.maxPrice)} per share with a spread of ${cents(RULES.maxSpread)} or less.`,
    `Live orders are market orders capped at ${cents(RULES.slippage)} above the current price, so they never fill worse than that.`,
    `One entry per market and at most ${RULES.maxOpen} open positions. Positions are held until Polymarket settles them.`
  ];

  return { KEY, RULES, defaults, load, save, sanitize, sync, setMoney, stake, fee, evaluate, rulesText, cents, secs, tfName };
})();
