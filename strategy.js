/* BlueEdge scalping strategy: low-odds entries, higher-odds exits.
 * This is a rule-based strategy, not a guarantee. No trading strategy can have a
 * win rate over 100%; the app therefore never claims a guaranteed win rate.
 */
window.BlueEdgeStrategy = (() => {
  const KEY = "blueedge.strategy.v3";
  const RULES = Object.freeze({
    entryMin: 0.10,
    entryMax: 0.40,
    exitMin: 0.45,
    takeProfit: 0.05,
    maxSpread: 0.02,
    skipFirst: 15,
    stopBefore: 15,
    maxOpen: 3,
    slippage: 0.02
  });
  const defaults = {
    timeframes: [5, 15, 60],
    risk: { mode: "pct", pct: 1, usd: 10 },
    maxOpen: 3
  };
  const clamp = (v, lo, hi, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const round2 = n => Math.round(n * 100) / 100;

  function sanitize(s) {
    const o = { ...defaults, ...s };
    o.timeframes = [...new Set((Array.isArray(o.timeframes) ? o.timeframes : defaults.timeframes)
      .map(Number))].filter(t => [5, 15, 60].includes(t)).sort((a, b) => a - b);
    o.risk = {
      mode: o.risk?.mode === "usd" ? "usd" : "pct",
      pct: clamp(o.risk?.pct, 0, 100, 1),
      usd: clamp(o.risk?.usd, 0, 1e9, 10)
    };
    o.maxOpen = Math.round(clamp(o.maxOpen, 1, 20, 3));
    return { timeframes: o.timeframes, risk: o.risk, maxOpen: o.maxOpen };
  }

  function load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY) || "null"); } catch {}
    if (!s) {
      try {
        const v2 = JSON.parse(localStorage.getItem("blueedge.strategy.v2") || "null");
        if (v2) s = { timeframes: v2.timeframes, risk: v2.risk };
      } catch {}
    }
    return sanitize(s || {});
  }

  const save = s => localStorage.setItem(KEY, JSON.stringify(sanitize(s)));

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

  const stake = (s, equity) =>
    s.risk.mode === "pct" ? equity * s.risk.pct / 100 : s.risk.usd;

  const fee = (shares, price, rate) =>
    Math.max(0, shares * (rate || 0) * price * (1 - price));

  const cents = p => p == null ? "—" :
    (Math.abs(p * 100 - Math.round(p * 100)) > 0.05
      ? (p * 100).toFixed(1)
      : Math.round(p * 100)) + "¢";

  const secs = s => {
    s = Math.max(0, Math.round(s));
    return s >= 60
      ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
      : `${s}s`;
  };

  const tfName = tf => tf === 60 ? "1 hour" : `${tf} min`;

  /*
   * Entry:
   * - Uses the Polymarket price-to-beat direction.
   * - Buys the outcome only when its current ask is in the low-odds band.
   * - Requires a tight book so the scalp is not paying excessive spread.
   *
   * ctx = {
   *   now, up:{bid,ask}, down:{bid,ask}, open, openExact,
   *   openSource, openNote, spot, spotSource, accepting
   * }
   */
  function evaluate(s, m, ctx) {
    const R = RULES, now = ctx.now;
    const elapsed = (now - m.start) / 1000;
    const left = (m.end - now) / 1000;
    const done = reason => ({
      ok: false, side: null, price: null, checks: [], reason
    });

    if (!s.timeframes.includes(m.tf)) return done(`${tfName(m.tf)} markets are off`);
    if (left <= 0) return done("Window closed");
    if (elapsed < 0) return done(`Opens in ${secs(-elapsed)}`);
    if (ctx.open == null || ctx.openExact === false)
      return done(ctx.openNote || "Waiting for Polymarket's exact price to beat");
    if (ctx.spot == null) return done("Waiting for the live reference price");
    if (ctx.spot === ctx.open) return done("Price is exactly at the price to beat");

    const side = ctx.spot > ctx.open ? "Up" : "Down";
    const book = side === "Up" ? ctx.up : ctx.down;
    const ask = Number(book.ask), bid = Number(book.bid);
    const checks = [];
    const add = (label, pass, why) => checks.push({ label, pass, why });

    add(`Live price is ${side === "Up" ? "above" : "below"} the price to beat`, true, "");
    add(`At least ${secs(R.skipFirst)} into the window`,
      elapsed >= R.skipFirst, `Entries open in ${secs(R.skipFirst - elapsed)}`);
    add(`At least ${secs(R.stopBefore)} left`,
      left >= R.stopBefore, "Too close to the close for a new scalp");
    add(`Buy ${side} only at ${cents(R.entryMin)}–${cents(R.entryMax)}`,
      Number.isFinite(ask) && ask >= R.entryMin && ask <= R.entryMax,
      !Number.isFinite(ask) ? `No ${side} sellers right now`
        : `${side} ask is ${cents(ask)}, outside the low-odds entry band`);
    add(`Spread ${cents(R.maxSpread)} or tighter`,
      Number.isFinite(ask) && Number.isFinite(bid) && ask - bid <= R.maxSpread + 1e-9,
      Number.isFinite(ask) && Number.isFinite(bid)
        ? `Spread is ${cents(ask - bid)}`
        : "Order book is one-sided");
    add("Accepting orders", m.accepting !== false, "Polymarket isn't accepting orders");

    const fail = checks.find(c => !c.pass);
    return {
      ok: !fail,
      side,
      price: Number.isFinite(ask) ? ask : null,
      bid: Number.isFinite(bid) ? bid : null,
      checks,
      reason: fail ? fail.why : `Scalp ready: buy ${side} at ${cents(ask)}`
    };
  }

  /*
   * Exit:
   * Sell a held token as soon as Polymarket's executable bid reaches the
   * higher-odds target. The target is the larger of:
   *   entry + takeProfit, or exitMin.
   */
  function exitSignal(s, m, position, book, now = Date.now()) {
    if (!position || position.status && position.status !== "open") return { ok: false, reason: "No open position" };
    const bid = Number(book?.bid);
    const entry = Number(position.entry);
    const left = (m.end - now) / 1000;
    if (!(bid > 0 && bid < 1) || !(entry > 0 && entry < 1))
      return { ok: false, reason: "Waiting for an executable sell bid" };

    const target = Math.min(0.99, Math.max(R.exitMin, entry + R.takeProfit));
    if (bid >= target) {
      return {
        ok: true,
        price: bid,
        target,
        reason: `Scalp target reached: sell at ${cents(bid)}`
      };
    }
    if (left <= R.stopBefore && bid > entry) {
      return {
        ok: true,
        price: bid,
        target,
        reason: `Window closing with profit: sell at ${cents(bid)}`
      };
    }
    return {
      ok: false,
      price: bid,
      target,
      reason: `Waiting for ${cents(target)}+; bid is ${cents(bid)}`
    };
  }

  const rulesText = (s = defaults) => [
    `Scalps the low-odds side: buy the Up or Down outcome only when its Polymarket ask is ${cents(RULES.entryMin)}–${cents(RULES.entryMax)}.`,
    `Direction comes from Polymarket's exact price-to-beat reference: above it buys Up; below it buys Down.`,
    `Only enters ${secs(RULES.skipFirst)} after a window opens, keeps a ${cents(RULES.maxSpread)} maximum spread, and avoids new entries with ${secs(RULES.stopBefore)} or less left.`,
    `Sells the held outcome when its executable bid reaches at least ${cents(RULES.exitMin)} or the entry price plus ${cents(RULES.takeProfit)}.`,
    `Orders are capped by the existing ${s.maxOpen} open-position limit and your existing percentage or dollar risk setting.`,
    `This is a scalping rule set, not a guaranteed-profit system. A mathematical win rate cannot exceed 100%.`
  ];

  return {
    KEY, RULES, defaults, load, save, sanitize, sync, setMoney, stake, fee,
    evaluate, exitSignal, rulesText, cents, secs, tfName
  };
})();
