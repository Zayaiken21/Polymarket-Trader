/* BlueEdge strategy: market filters + risk. No signal scores.
 * Risk and daily loss are stored as { mode: "pct" | "usd", pct, usd } and always kept in sync against equity.
 */
window.BlueEdgeStrategy = (() => {
  const KEY = "blueedge.strategy.v2";
  const defaults = {
    timeframes: [5, 15, 60],
    side: "follow",          // follow | up | down | cheaper
    minPrice: 0.35,
    maxPrice: 0.75,
    maxSpread: 0.03,
    minLiquidity: 0,
    skipFirst: 30,           // seconds after the window opens
    stopBefore: 60,          // seconds before the window closes
    exit: "hold",            // hold | tpsl
    takeProfit: 0.92,
    stopLoss: 0.20,
    risk: { mode: "pct", pct: 1, usd: 100 },
    daily: { mode: "pct", pct: 5, usd: 500 },
    maxOpen: 3
  };

  const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const round2 = n => Math.round(n * 100) / 100;

  function sanitize(s) {
    const o = { ...defaults, ...s };
    o.timeframes = [...new Set((Array.isArray(o.timeframes) ? o.timeframes : defaults.timeframes).map(Number))].filter(t => [5, 15, 60].includes(t));
    o.side = ["follow", "up", "down", "cheaper"].includes(o.side) ? o.side : "follow";
    o.minPrice = clamp(o.minPrice, 0.01, 0.99, defaults.minPrice);
    o.maxPrice = clamp(o.maxPrice, 0.01, 0.99, defaults.maxPrice);
    o.maxSpread = clamp(o.maxSpread, 0.01, 0.5, defaults.maxSpread);
    o.minLiquidity = clamp(o.minLiquidity, 0, 1e9, 0);
    o.skipFirst = clamp(o.skipFirst, 0, 3000, defaults.skipFirst);
    o.stopBefore = clamp(o.stopBefore, 0, 3000, defaults.stopBefore);
    o.exit = o.exit === "tpsl" ? "tpsl" : "hold";
    o.takeProfit = clamp(o.takeProfit, 0.02, 0.99, defaults.takeProfit);
    o.stopLoss = clamp(o.stopLoss, 0.01, 0.98, defaults.stopLoss);
    const money = (m, d) => ({ mode: m?.mode === "usd" ? "usd" : "pct", pct: clamp(m?.pct, 0, 100, d.pct), usd: clamp(m?.usd, 0, 1e9, d.usd) });
    o.risk = money(o.risk, defaults.risk);
    o.daily = money(o.daily, defaults.daily);
    o.maxOpen = Math.round(clamp(o.maxOpen, 1, 50, defaults.maxOpen));
    return o;
  }

  function load() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(KEY) || "null"); } catch {}
    if (!s) {
      // carry over the risk numbers from the old build if they exist
      try {
        const v1 = JSON.parse(localStorage.getItem("blueedge.strategy.v1") || "null");
        if (v1) s = { risk: { mode: "pct", pct: v1.risk, usd: 100 }, daily: { mode: "pct", pct: v1.daily, usd: 500 }, maxOpen: v1.maxTrades, stopBefore: v1.cutoff, maxPrice: v1.entry };
      } catch {}
    }
    return sanitize(s || {});
  }
  const save = s => localStorage.setItem(KEY, JSON.stringify(sanitize(s)));

  /* ---- synced money fields ---- */
  function sync(obj, base) {
    const b = Math.max(0, Number(base) || 0);
    if (obj.mode === "pct") obj.usd = round2(b * obj.pct / 100);
    else obj.pct = b > 0 ? round2(obj.usd / b * 100) : 0;
    return obj;
  }
  function setMoney(obj, field, value, base) {
    obj.mode = field === "usd" ? "usd" : "pct";
    obj[obj.mode] = Math.max(0, Number(value) || 0);
    return sync(obj, base);
  }
  const stake = (s, equity) => s.risk.mode === "pct" ? equity * s.risk.pct / 100 : s.risk.usd;
  const dailyLimit = (s, dayStartEquity) => s.daily.mode === "pct" ? dayStartEquity * s.daily.pct / 100 : s.daily.usd;

  /* Polymarket crypto taker fee: shares × rate × p × (1 − p) */
  const fee = (shares, price, rate) => Math.max(0, shares * (rate || 0) * price * (1 - price));

  const cents = p => p == null ? "—" : (Math.abs(p * 100 - Math.round(p * 100)) > 0.05 ? (p * 100).toFixed(1) : Math.round(p * 100)) + "¢";
  const secs = s => { s = Math.max(0, Math.round(s)); return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`; };
  const tfName = tf => tf === 60 ? "1 hour" : `${tf} min`;

  /* ---- evaluation ----
   * ctx = { now, up:{bid,ask}, down:{bid,ask}, open, spot }
   * returns { ok, side, price, checks:[{label, pass, why}], reason }
   */
  function evaluate(s, m, ctx) {
    const now = ctx.now;
    const elapsed = (now - m.start) / 1000, left = (m.end - now) / 1000;
    const done = (reason, extra = {}) => ({ ok: false, side: null, price: null, checks: [], reason, ...extra });
    if (!s.timeframes.includes(m.tf)) return done(`${tfName(m.tf)} markets are off in your strategy`);
    if (left <= 0) return done("Window closed");
    if (elapsed < 0) return done(`Opens in ${secs(-elapsed)}`);

    let side = null;
    if (s.side === "up") side = "Up";
    else if (s.side === "down") side = "Down";
    else if (s.side === "cheaper") {
      const ua = ctx.up.ask, da = ctx.down.ask;
      if (ua == null && da == null) return done("Waiting for Polymarket prices");
      side = (ua ?? 2) <= (da ?? 2) ? "Up" : "Down";
    } else {
      if (ctx.open == null || ctx.spot == null) return done("Waiting for the Binance window open");
      if (ctx.spot === ctx.open) return done("Binance is flat vs. the window open");
      side = ctx.spot > ctx.open ? "Up" : "Down";
    }

    const book = side === "Up" ? ctx.up : ctx.down;
    const ask = book.ask, bid = book.bid;
    const lo = Math.min(s.minPrice, s.maxPrice), hi = Math.max(s.minPrice, s.maxPrice);
    const checks = [];
    const add = (label, pass, why) => checks.push({ label, pass, why });
    add(`Wait ${secs(s.skipFirst)} after open`, elapsed >= s.skipFirst, `Entries open in ${secs(s.skipFirst - elapsed)}`);
    add(`Stop with ${secs(s.stopBefore)} left`, left >= s.stopBefore, "Too close to the close for new entries");
    add(`${side} price ${cents(lo)}–${cents(hi)}`, ask != null && ask >= lo - 1e-9 && ask <= hi + 1e-9,
      ask == null ? `No ${side} sellers right now` : `${side} is ${cents(ask)}, outside your ${cents(lo)}–${cents(hi)} range`);
    add(`Spread ≤ ${cents(s.maxSpread)}`, ask != null && bid != null && ask - bid <= s.maxSpread + 1e-9,
      ask != null && bid != null ? `Spread is ${cents(ask - bid)}` : "Order book is one-sided");
    if (s.minLiquidity > 0) add(`Liquidity ≥ $${s.minLiquidity.toLocaleString()}`, m.liquidity >= s.minLiquidity, `Liquidity is $${Math.round(m.liquidity).toLocaleString()}`);
    add("Accepting orders", m.accepting !== false, "Polymarket isn't accepting orders");
    const fail = checks.find(c => !c.pass);
    return { ok: !fail, side, price: ask, checks, reason: fail ? fail.why : `Ready: buy ${side} at ${cents(ask)}` };
  }

  function summary(s, equity, dayStart) {
    const sideText = { follow: "the side Binance is moving toward since the window opened", up: "Up", down: "Down", cheaper: "whichever side is cheaper" }[s.side];
    const tfs = s.timeframes.length ? s.timeframes.map(tfName).join(", ") : "no timeframes (bot will idle)";
    const r = sync({ ...s.risk }, equity), d = sync({ ...s.daily }, dayStart);
    const money = n => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return [
      `Scan every live crypto Up or Down market on ${tfs}.`,
      `Buy ${sideText} when it costs ${cents(Math.min(s.minPrice, s.maxPrice))}–${cents(Math.max(s.minPrice, s.maxPrice))} and the spread is ${cents(s.maxSpread)} or tighter${s.minLiquidity ? `, with at least $${s.minLiquidity.toLocaleString()} liquidity` : ""}.`,
      `Only enter ${secs(s.skipFirst)} after a window opens and stop with ${secs(s.stopBefore)} left.`,
      s.exit === "hold" ? "Hold every position until Polymarket settles it." : `Sell early at ${cents(s.takeProfit)} or cut at ${cents(s.stopLoss)}; otherwise hold to settlement.`,
      `Stake ${money(r.usd)} (${r.pct}% of equity) per trade, ${s.maxOpen} open at most. Pause after losing ${money(d.usd)} (${d.pct}%) in a day.`
    ];
  }

  return { KEY, defaults, load, save, sanitize, sync, setMoney, stake, dailyLimit, fee, evaluate, summary, cents, secs, tfName };
})();
