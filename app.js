(() => {
  const D = window.BlueEdgeData, S = window.BlueEdgeStrategy, L = window.BlueEdgeLive, C = window.BlueEdgeChart;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const K = { account: "blueedge.account.v2", trades: "blueedge.trades.v2", bot: "blueedge.bot.v3", mode: "blueedge.mode.v1", leader: "blueedge.leader.v2", ui: "blueedge.ui.v3", liveTried: "blueedge.liveTried.v1" };
  const TAB = Math.random().toString(36).slice(2);
  const NAMES = { BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", XRP: "XRP", DOGE: "Dogecoin", BNB: "BNB", HYPE: "Hyperliquid", ADA: "Cardano", LINK: "Chainlink", LTC: "Litecoin", AVAX: "Avalanche", SUI: "Sui", TON: "Toncoin" };
  const COLORS = { BTC: "#F7931A", ETH: "#8A92F5", SOL: "#35D6B0", XRP: "#C9D4E2", DOGE: "#D6B64A", BNB: "#F0B90B", HYPE: "#7DE3CF" };
  const TITLES = { home: "Home", markets: "Markets", chart: "Chart", trades: "Trades", settings: "Settings" };
  const WALLET_TYPES = { 0: "EOA", 1: "Proxy wallet", 2: "Safe wallet", 3: "Deposit wallet" };

  /* ---------- storage ---------- */
  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v ?? d; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const todayKey = () => new Date().toDateString();

  function loadAccount() {
    const a = read(K.account, null) || {};
    return { name: "", startBalance: 10000, cash: 10000, dayKey: todayKey(), dayStart: 10000, refreshSec: 60, botMode: "auto", ...a };
  }
  let account = loadAccount();
  let trades = read(K.trades, []);
  let strategy = S.load();
  let botOn = read(K.bot, false) === true;
  let mode = read(K.mode, "paper") === "live" ? "live" : "paper";
  const IV_TO_TF = { "1m": 5, "3m": 5, "5m": 5, "15m": 15, "30m": 60, "1h": 60, "2h": 60, "4h": 60, "6h": 60, "8h": 60, "12h": 60, "1d": 60, "3d": 60, "1w": 60, "1M": 60 };
  const ui = { homeTf: "all", marketsTf: "all", marketsWhen: "live", chartCoin: "BTC", chartInterval: "15m", chartPtbTf: 15, chartMarket: null, ...read(K.ui, {}) };
  let botNote = "", view = "home", liveBusy = false;
  const offered = new Set();

  const reloadBook = () => { account = loadAccount(); trades = read(K.trades, []); };
  const saveAccount = () => write(K.account, account);
  const saveTrades = () => {
    const open = trades.filter(t => t.status === "open");
    const closed = trades.filter(t => t.status !== "open").slice(-1000);
    trades = [...closed, ...open].sort((a, b) => a.openedAt - b.openedAt);
    write(K.trades, trades);
  };
  const saveUi = () => write(K.ui, ui);
  const liveTried = () => { const m = read(K.liveTried, {}); const now = Date.now(); for (const k in m) if (now - m[k] > 3 * 3600e3) delete m[k]; return m; };

  /* ---------- formatting ---------- */
  const cents = S.cents;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const money = (n, signed = false) => { const v = Number(n) || 0; return (v < -0.004 ? "−" : signed && v > 0.004 ? "+" : "") + fmtUsd.format(Math.abs(v)); };
  const clock = ms => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`; };
  const tfShort = tf => (tf === 60 ? "1h" : `${tf}m`);
  const coinName = a => NAMES[a] || a;
  const coinColor = a => COLORS[a] || "#4DA3FF";
  // same precision Polymarket shows: 2 decimals from $100, 4 from $1, 6 below $1 (e.g. DOGE $0.080589)
  const fmtPrice = p => p == null ? "—" : p >= 1000 ? "$" + p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : p >= 1 ? "$" + p.toFixed(p >= 100 ? 2 : 4) : "$" + p.toFixed(6);
  const set = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
  const html = (el, h) => { if (el && el._html !== h) { el.innerHTML = h; el._html = h; } };
  const signClass = n => (n > 0.004 ? "gain" : n < -0.004 ? "loss" : "");
  const shortAddr = a => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—";
  const ago = ms => { const s = Math.round((Date.now() - ms) / 1000); return s < 5 ? "just now" : s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`; };
  const symFromTitle = t => { const w = String(t || "").trim().split(/\s+/)[0] || "?"; const hit = Object.entries(NAMES).find(([, n]) => n.toLowerCase() === w.toLowerCase()); return hit ? hit[0] : w.slice(0, 4).toUpperCase(); };
  const coinBadge = (a, cls = "") => `<span class="coin ${cls}" style="--coin:${coinColor(a)}">${esc(String(a).slice(0, 4))}</span>`;

  /* ---------- money / equity ---------- */
  const isLive = () => mode === "live";
  const openTrades = () => trades.filter(t => t.status === "open");
  const markOf = t => D.bookFor(t.token).bid ?? t.entry;
  const paperEquity = () => account.cash + openTrades().reduce((s, t) => s + t.shares * markOf(t), 0);
  const equity = () => (isLive() ? L.equity() : paperEquity());
  function rollDay() { if (account.dayKey !== todayKey()) { account.dayKey = todayKey(); account.dayStart = paperEquity(); saveAccount(); } }

  function tokenIndex() {
    const map = new Map();
    for (const m of D.markets()) { map.set(m.upToken, { m, side: "Up" }); map.set(m.downToken, { m, side: "Down" }); }
    return map;
  }

  /* ---------- market view model ---------- */
  const mid = b => (b.bid != null && b.ask != null ? (b.bid + b.ask) / 2 : b.ask ?? b.bid ?? null);
  function vm(m, now = Date.now()) {
    const ub = D.bookFor(m.upToken), db = D.bookFor(m.downToken);
    const ptb = D.priceToBeat(m), lp = D.livePrice(m);
    const ctx = { now, up: { bid: ub.bid ?? null, ask: ub.ask ?? null }, down: { bid: db.bid ?? null, ask: db.ask ?? null }, open: ptb?.exact ? ptb.price : null, shownOpen: ptb?.exact ? ptb.price : (ptb?.estPrice ?? null), openExact: !!ptb?.exact, openSource: ptb?.exact ? (ptb.source || "") : (ptb?.estSource || ""), spot: lp?.price ?? null, spotSource: lp?.source || "" };
    const um = mid(ctx.up), dm = mid(ctx.down);
    return {
      m, ctx, decision: S.evaluate(strategy, m, ctx), res: D.resolutionFor(m.id),
      upProb: um != null ? um : dm != null ? 1 - dm : null,
      move: ctx.shownOpen != null && ctx.spot != null ? (ctx.spot - ctx.shownOpen) / ctx.shownOpen : null,
      live: m.start <= now && m.end > now, left: m.end - now,
      progress: Math.min(1, Math.max(0, (now - m.start) / (m.end - m.start)))
    };
  }
  const liveMarkets = (now = Date.now()) => D.markets().filter(m => m.start <= now && m.end > now);

  function holdingFor(m) {
    if (!isLive()) { const t = trades.find(x => x.status === "open" && x.marketId === m.id); return t ? { side: t.side, shares: t.shares, entry: t.entry, token: t.token, id: t.id } : null; }
    const p = L.state.positions.find(x => String(x.assetId ?? x.tokenId) === m.upToken || String(x.assetId ?? x.tokenId) === m.downToken);
    if (!p) return null;
    const token = String(p.assetId ?? p.tokenId);
    return { side: token === m.upToken ? "Up" : "Down", shares: Number(p.currentSize ?? p.size), entry: Number(p.avgPrice), token };
  }

  /* ---------- keyed lists ---------- */
  function keyed(container, items, keyOf, create, update, emptyHtml) {
    const map = container._nodes || (container._nodes = new Map());
    const keys = new Set(items.map(keyOf));
    for (const [k, el] of map) if (!keys.has(k)) { el.remove(); map.delete(k); }
    let empty = container.querySelector(":scope > .empty");
    if (!items.length) {
      if (!empty) { empty = document.createElement("div"); empty.className = "empty"; container.append(empty); }
      html(empty, emptyHtml);
      return;
    }
    empty?.remove();
    items.forEach((item, i) => {
      const k = keyOf(item);
      let el = map.get(k);
      if (!el) { el = create(item); map.set(k, el); }
      if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
      update(el, item);
    });
  }
  const field = (el, name) => el.querySelector(`[data-f="${name}"]`);

  /* ---------- market cards ---------- */
  function createCard(v) {
    const m = v.m, el = document.createElement("article");
    el.className = "mcard"; el.dataset.id = m.id; el.tabIndex = 0; el.setAttribute("role", "button");
    el.setAttribute("aria-label", `${coinName(m.asset)} ${S.tfName(m.tf)} market`);
    el.innerHTML = `
      <div class="mc-head">${coinBadge(m.asset)}
        <div class="mc-name"><b>${esc(coinName(m.asset))}</b><span>${S.tfName(m.tf)} window</span></div>
        <span class="mc-left" data-f="left"></span></div>
      <div class="mc-progress"><i data-f="progress"></i></div>
      <div class="mc-odds">
        <button class="odd up" data-buy="Up"><span>Up</span><b data-f="upAsk"></b></button>
        <button class="odd down" data-buy="Down"><span>Down</span><b data-f="downAsk"></b></button>
      </div>
      <div class="split" aria-hidden="true"><i data-f="split"></i></div>
      <div class="mc-foot"><span data-f="spot"></span><span data-f="move"></span></div>
      <p class="mc-status" data-f="status"></p>`;
    return el;
  }
  function pulse(node, dir) {
    if (!node) return;
    node.classList.remove("flash-up", "flash-down", "flash");
    void node.offsetWidth;
    node.classList.add(dir === "up" ? "flash-up" : dir === "down" ? "flash-down" : "flash");
  }
  function tickFlash(el, key, value, node) {
    const prev = el["_" + key];
    el["_" + key] = value;
    if (prev == null || value == null || prev === value) return;
    pulse(node, value > prev ? "up" : "down");
  }
  function updateCard(el, v) {
    const now = Date.now();
    tickFlash(el, "ua", v.ctx.up.ask, el.querySelector(".odd.up"));
    tickFlash(el, "da", v.ctx.down.ask, el.querySelector(".odd.down"));
    const ended = v.m.end <= now;
    set(field(el, "left"), v.live ? clock(v.left) : v.m.start > now ? `in ${clock(v.m.start - now)}` : "ended");
    field(el, "progress").style.transform = `scaleX(${v.progress.toFixed(4)})`;
    set(field(el, "upAsk"), cents(v.ctx.up.ask));
    set(field(el, "downAsk"), cents(v.ctx.down.ask));
    field(el, "split").style.transform = `scaleX(${(v.upProb ?? 0.5).toFixed(4)})`;
    set(field(el, "spot"), v.ctx.shownOpen != null ? `To beat ${fmtPrice(v.ctx.shownOpen)}` : v.m.start > now ? "To beat: at open" : "To beat —");
    const mv = field(el, "move");
    set(mv, v.ctx.spot == null ? "" : `${fmtPrice(v.ctx.spot)}${v.move == null ? "" : ` ${v.move >= 0 ? "▲" : "▼"}${(Math.abs(v.move) * 100).toFixed(3)}%`}`);
    mv.className = v.move == null ? "" : v.move >= 0 ? "gain" : "loss";
    const held = holdingFor(v.m);
    const st = field(el, "status");
    if (ended) {
      set(st, v.res ? `Resolved ${v.res.winner}${v.res.official ? "" : " (estimated)"}${held ? `, you held ${held.side}` : ""}` : "Waiting for the official result…");
      st.className = "mc-status " + (v.res ? (v.res.winner === "Up" ? "res-up" : "res-down") : "wait");
    } else {
      set(st, held ? `You hold ${held.side}` : v.decision.reason === "Waiting for the price to beat" ? "Syncing Polymarket's price to beat" : v.decision.reason);
      st.className = "mc-status " + (held ? "held" : v.decision.ok ? "ready" : /are off/.test(v.decision.reason) ? "off" : "wait");
    }
    el.classList.toggle("is-ready", v.decision.ok && !held);
    el.classList.toggle("is-urgent", v.live && v.left < 60000);
  }
  function marketsEmpty() {
    const st = D.state.status;
    if (st.gamma === "idle" || (st.gamma === "loading" && !st.lastDiscovery)) return `<div class="loader"></div><p>Finding live crypto markets on Polymarket…</p>`;
    if (st.gamma === "error") return `<p><b>Couldn't load markets.</b> ${esc(st.gammaMsg)}</p><button class="btn small" data-action="refresh">Try again</button>`;
    return `<p><b>Nothing live on these filters.</b> New windows are picked up automatically.</p>`;
  }

  /* ---------- sheet ---------- */
  let sheet = null;
  function openSheet(id, side) {
    const m = D.state.markets.get(id);
    if (!m) return;
    sheet = { id, side: side || null };
    $("#sheet").innerHTML = `
      <div class="sheet-grip" aria-hidden="true"></div>
      <div class="sheet-head">${coinBadge(m.asset)}
        <div><h2 id="sheetTitle">${esc(coinName(m.asset))} ${S.tfName(m.tf)}</h2><p class="muted" data-f="window"></p></div>
        <button class="icon-btn" data-action="close-sheet" aria-label="Close">✕</button></div>
      <div class="sheet-clock"><b data-f="left"></b><span data-f="leftLabel"></span></div>
      <div class="mc-progress big"><i data-f="progress"></i></div>
      <div class="sides" role="radiogroup" aria-label="Side">
        <button class="side up" role="radio" data-side="Up"><span>Up</span><b data-f="upAsk"></b><small data-f="upBid"></small></button>
        <button class="side down" role="radio" data-side="Down"><span>Down</span><b data-f="downAsk"></b><small data-f="downBid"></small></button>
      </div>
      <dl class="kv">
        <div><dt>Price to beat</dt><dd data-f="open"></dd></div><div><dt>Live price</dt><dd data-f="spot"></dd></div>
        <div><dt>Difference</dt><dd data-f="move"></dd></div><div><dt>Liquidity</dt><dd data-f="liq"></dd></div>
      </dl>
      <div class="ticket">
        <div class="ticket-row"><span>Account</span><b data-f="acct"></b></div>
        <div class="ticket-row"><span>Stake</span><b data-f="stake"></b></div>
        <div class="ticket-row"><span>Est. shares</span><b data-f="shares"></b></div>
        <div class="ticket-row strong"><span data-f="payLabel"></span><b data-f="payout"></b></div>
      </div>
      <div class="holding" data-f="holding" hidden></div>
      <ul class="checks" data-f="checks"></ul>
      <div class="sheet-actions">
        <button class="btn primary big" data-action="sheet-buy" data-f="buyBtn"></button>
        <button class="btn ghost" data-action="sheet-chart">Show on chart</button>
        <a class="btn ghost" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">Open on Polymarket</a>
      </div>
      <p class="hint center" data-f="note"></p>`;
    $("#sheet").classList.add("open"); $("#backdrop").classList.add("open"); document.body.classList.add("sheet-open");
    updateSheet();
  }
  const polyUrl = (slug, eventSlug) => (slug || eventSlug ? `https://polymarket.com/event/${eventSlug || slug}` : null);
  const when = ms => ms ? new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const toMs = raw => raw == null || raw === "" ? null : isNaN(raw) ? Date.parse(raw) : Number(raw) * (String(Math.floor(Number(raw))).length <= 10 ? 1000 : 1);
  function openDetail(d) {
    sheet = null;
    $("#sheet").innerHTML = `
      <div class="sheet-grip" aria-hidden="true"></div>
      <div class="sheet-head">${coinBadge(d.asset || "?")}
        <div><h2 id="sheetTitle">${esc(d.title)}</h2><p class="muted">${esc(d.subtitle || "")}</p></div>
        <button class="icon-btn" data-action="close-sheet" aria-label="Close">✕</button></div>
      ${d.badge ? `<p class="detail-badge ${d.badgeClass || ""}">${esc(d.badge)}</p>` : ""}
      <dl class="kv detail">${d.rows.filter(r => r[1] != null && r[1] !== "").map(([k, v, c]) => `<div><dt>${esc(k)}</dt><dd class="${c || ""}">${esc(v)}</dd></div>`).join("")}</dl>
      <div class="sheet-actions">${d.actions || ""}${d.url ? `<a class="btn ghost" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">Open on Polymarket</a>` : ""}</div>`;
    $("#sheet").classList.add("open"); $("#backdrop").classList.add("open"); document.body.classList.add("sheet-open");
  }
  function paperDetail(id) {
    const t = trades.find(x => x.id === id); if (!t) return;
    const m = D.state.markets.get(t.marketId), now = Date.now();
    if (t.status === "open" && m && m.end > now) return openSheet(m.id, t.side);
    const res = D.resolutionFor(t.marketId), bid = D.bookFor(t.token).bid;
    const statusText = t.status === "open" ? (t.end > now ? "Open" : "Waiting for result") : t.status === "won" ? "Won" : t.status === "lost" ? "Lost" : t.note || t.status;
    openDetail({
      asset: t.asset, title: `${coinName(t.asset)} ${S.tfName(t.tf)}, ${t.side}`, subtitle: `Paper trade opened ${when(t.openedAt)}`,
      badge: statusText, badgeClass: t.status === "won" ? "gain" : t.status === "lost" ? "loss" : "",
      rows: [["Shares", t.shares.toFixed(2)], ["Entry price", cents(t.entry)], ["Cost", money(t.cost)], ["Fees", money((t.fee || 0) + (t.exitFee || 0))],
        ["Exit price", t.exit != null ? cents(t.exit) : t.status === "open" ? `now ${cents(bid)}` : "—"], ["P/L", t.pnl != null ? money(t.pnl, true) : "—", signClass(t.pnl)],
        ["Window", `${new Date(t.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} – ${new Date(t.end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`],
        ["Resolved", res ? `${res.winner}${res.official ? " (official)" : " (estimated)"}` : t.status === "open" ? "Not yet" : (t.note || "—")], ["Placed by", t.source === "bot" ? "Bot" : "You"]],
      url: t.url
    });
  }
  function livePositionDetail(token) {
    const p = L.state.positions.find(x => String(x.assetId ?? x.tokenId) === token); if (!p) return;
    const d = describeToken(token, tokenIndex()), now = Date.now();
    if (d?.m && d.m.end > now) return openSheet(d.m.id, d.m.upToken === token ? "Up" : "Down");
    const size = Number(p.currentSize ?? p.size ?? 0), value = Number(p.currentValue || 0), cost = Number(p.totalCostUsdc ?? size * Number(p.avgPrice || 0));
    openDetail({
      asset: d?.asset || symFromTitle(p.title), title: d?.label || p.title || "Position", subtitle: p.outcome ? `Outcome: ${p.outcome}` : "Live position",
      badge: p.redeemable ? "Resolved: Polymarket redeems it automatically" : "Open position",
      rows: [["Shares", size.toFixed(2)], ["Avg price", cents(Number(p.avgPrice))], ["Current price", cents(Number(p.currentPrice))], ["Value", money(value)], ["Cost", money(cost)], ["P/L", money(value - cost, true), signClass(value - cost)], ["Ends", p.endDate ? when(toMs(p.endDate)) : ""]],
      url: polyUrl(p.slug, p.eventSlug)
    });
  }
  function liveOrderDetail(id) {
    const o = L.state.orders.find(x => String(x.id) === id); if (!o) return;
    const d = describeToken(o.assetId ?? o.tokenId, tokenIndex());
    openDetail({
      asset: d?.asset || "?", title: `${o.side} ${d?.label || o.outcome || "order"}`, subtitle: "Open order on your live account", badge: String(o.status || "open").toLowerCase(),
      rows: [["Limit price", cents(Number(o.price))], ["Size", Number(o.originalSize || 0).toFixed(2)], ["Filled", Number(o.sizeMatched || 0).toFixed(2)], ["Value", money(Number(o.originalSize || 0) * Number(o.price || 0))], ["Type", o.orderType || ""], ["Order ID", o.id]],
      actions: `<button class="btn danger" data-cancel="${esc(o.id)}">Cancel order</button>`,
      url: d?.m?.url
    });
  }
  function liveFillDetail(i) {
    const t = L.state.trades[i]; if (!t) return;
    const d = describeToken(t.assetId ?? t.tokenId ?? t.asset_id, tokenIndex());
    openDetail({ asset: d?.asset || "?", title: `${t.side || ""} ${d?.label || t.outcome || "Fill"}`, subtitle: when(toMs(t.matchTime || t.createdAt || t.timestamp)), badge: String(t.status || "filled").replace("TRADE_STATUS_", "").toLowerCase(),
      rows: [["Shares", Number(t.size || 0).toFixed(2)], ["Price", cents(Number(t.price))], ["Value", money(Number(t.size || 0) * Number(t.price || 0))], ["Outcome", t.outcome || d?.label || ""]], url: d?.m?.url });
  }
  function liveClosedDetail(i) {
    const c = L.state.closed[i]; if (!c) return;
    const d = describeToken(c.assetId, tokenIndex());
    openDetail({ asset: d?.asset || symFromTitle(c.title), title: c.title || d?.label || "Closed position", subtitle: when(toMs(c.timestamp)),
      badge: Number(c.realizedPnl) >= 0 ? "Closed in profit" : "Closed at a loss", badgeClass: signClass(Number(c.realizedPnl)),
      rows: [["Outcome", c.outcome || ""], ["Avg price", cents(Number(c.avgPrice))], ["Shares bought", Number(c.totalBought || 0).toFixed(2)], ["Final price", cents(Number(c.currentPrice))], ["Realized P/L", money(Number(c.realizedPnl || 0), true), signClass(Number(c.realizedPnl))]],
      url: polyUrl(c.slug, c.eventSlug) });
  }
  function closeSheet() { sheet = null; $("#sheet").classList.remove("open"); $("#backdrop").classList.remove("open"); document.body.classList.remove("sheet-open"); }
  function updateSheet() {
    if (!sheet) return;
    const m = D.state.markets.get(sheet.id);
    if (!m) return closeSheet();
    const el = $("#sheet"), v = vm(m), now = Date.now(), f = n => field(el, n);
    const side = sheet.side || v.decision.side || "Up";
    const book = side === "Up" ? v.ctx.up : v.ctx.down;
    const tf = { hour: "numeric", minute: "2-digit" };
    set(f("window"), `${new Date(m.start).toLocaleTimeString([], tf)} – ${new Date(m.end).toLocaleTimeString([], tf)}`);
    set(f("left"), v.live ? clock(v.left) : m.start > now ? clock(m.start - now) : "0:00");
    set(f("leftLabel"), v.live ? "left in this window" : m.start > now ? "until this window opens" : v.res ? `resolved ${v.res.winner}${v.res.official ? " (official)" : " (estimated)"}` : "closed, waiting for result");
    f("progress").style.transform = `scaleX(${v.progress.toFixed(4)})`;
    set(f("upAsk"), cents(v.ctx.up.ask)); set(f("downAsk"), cents(v.ctx.down.ask));
    set(f("upBid"), `sell ${cents(v.ctx.up.bid)}`); set(f("downBid"), `sell ${cents(v.ctx.down.bid)}`);
    $$(".side", el).forEach(b => b.setAttribute("aria-checked", String(b.dataset.side === side)));
    set(f("open"), v.ctx.shownOpen == null ? (m.start > now ? `Set when it opens in ${clock(m.start - now)}` : "Syncing with Polymarket") : `${fmtPrice(v.ctx.shownOpen)} (${v.ctx.openSource})`);
    set(f("spot"), v.ctx.spot == null ? "—" : `${fmtPrice(v.ctx.spot)} ${v.ctx.spotSource ? `(${v.ctx.spotSource})` : ""}`);
    const mv = f("move"); set(mv, v.move == null ? "—" : `${v.move >= 0 ? "+" : "−"}$${Math.abs(v.ctx.spot - v.ctx.shownOpen).toFixed(v.ctx.shownOpen >= 100 ? 2 : v.ctx.shownOpen >= 1 ? 4 : 5)} ${v.move >= 0 ? "above" : "below"} (${(Math.abs(v.move) * 100).toFixed(3)}%)`);
    set(f("liq"), m.liquidity ? "$" + Math.round(m.liquidity).toLocaleString() : "—");

    const live = isLive();
    const cash = live ? (L.state.balance ?? 0) : account.cash;
    const stake = Math.min(S.stake(strategy, equity()), cash);
    const ask = book.ask;
    const shares = ask > 0 && ask < 1 ? Math.floor((stake / ask) * 100) / 100 : 0;
    set(f("acct"), live ? (L.canTrade() ? "Live (real money)" : L.isUnlocked() ? "Live, read-only" : "Live, locked") : "Paper");
    f("acct").className = live ? "loss" : "";
    set(f("stake"), money(stake));
    set(f("shares"), shares ? shares.toFixed(2) : "—");
    set(f("payLabel"), `Pays if ${side} wins`);
    set(f("payout"), shares ? money(shares) : "—");

    const held = holdingFor(m), h = f("holding");
    h.hidden = !held;
    if (held) {
      const bid = D.bookFor(held.token).bid;
      const pnl = held.shares * (bid ?? held.entry) - held.shares * held.entry;
      html(h, `<div><b>You hold ${held.shares.toFixed(2)} ${esc(held.side)}</b><span>Avg ${cents(held.entry)}, now ${cents(bid)}</span></div><span class="${signClass(pnl)}">${money(pnl, true)}</span><button class="btn small" data-sell-market="${esc(m.id)}">Sell</button>`);
    }
    const checks = v.decision.checks.length ? v.decision.checks.map(c => `<li class="${c.pass ? "ok" : "no"}">${esc(c.pass ? c.label : c.why)}</li>`).join("") : `<li class="no">${esc(v.decision.reason)}</li>`;
    html(f("checks"), `<li class="checks-title">What the bot sees</li>${checks}`);

    const btn = f("buyBtn");
    let blocked = "";
    if (!v.live && m.start <= now) blocked = "Window closed";
    else if (held) blocked = "Already holding";
    else if (live && !L.isUnlocked()) blocked = "Unlock your live account";
    else if (live && !L.canTrade()) blocked = "Account is read-only";
    else if (!(ask > 0 && ask < 1)) blocked = `No ${side} sellers`;
    else if (live ? stake < 1 : shares < m.minShares) blocked = live ? "Stake must be at least $1" : `Min ${m.minShares} shares`;
    set(btn, blocked || `Buy ${side} for ${money(live ? stake : shares * ask)}${live ? " (live)" : ""}`);
    btn.disabled = !!blocked || liveBusy;
    btn.classList.toggle("down", side === "Down");
    set(f("note"), live ? `Real order: market buy on Polymarket, never above ${cents(Math.min(0.99, (ask ?? 0) + S.RULES.slippage))}.` : "Paper trade at the live Polymarket ask. No real money moves.");
  }

  /* ---------- paper trading ---------- */
  function paperBuy(m, side, source) {
    const fail = msg => { if (source !== "bot") toast(msg, "bad"); return { ok: false, msg }; };
    reloadBook(); rollDay();
    if (m.end <= Date.now()) return fail("This window has closed.");
    if (trades.some(t => t.status === "open" && t.marketId === m.id)) return fail("You already hold this market.");
    const token = side === "Up" ? m.upToken : m.downToken;
    const ask = D.bookFor(token).ask;
    if (!(ask > 0 && ask < 1)) return fail(`No ${side} sellers right now.`);
    const stake = Math.min(S.stake(strategy, paperEquity()), account.cash);
    const shares = Math.floor((stake / ask) * 100) / 100;
    if (shares < m.minShares) return fail(`Stake is too small. Polymarket's minimum is ${m.minShares} shares (${money(m.minShares * ask)}).`);
    const cost = shares * ask, fee = S.fee(shares, ask, m.feeRate);
    if (cost + fee > account.cash + 1e-9) return fail("Not enough paper cash.");
    account.cash -= cost + fee;
    trades.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), marketId: m.id, slug: m.slug, url: m.url, asset: m.asset, tf: m.tf, start: m.start, end: m.end, side, outcome: side === "Up" ? m.upLabel : m.downLabel, token, upToken: m.upToken, resolutionSource: m.resolutionSource || "", feeRate: m.feeRate, entry: ask, shares, cost, fee, openedAt: Date.now(), status: "open", source });
    saveAccount(); saveTrades(); watchOpen();
    toast(`${source === "bot" ? "Bot bought" : "Bought"} ${shares.toFixed(2)} ${side} on ${m.asset} ${tfShort(m.tf)} at ${cents(ask)} (paper)`, "good");
    render();
    return { ok: true };
  }
  function paperSell(id, why = "Sold") {
    reloadBook();
    const t = trades.find(x => x.id === id && x.status === "open");
    if (!t) return;
    const bid = D.bookFor(t.token).bid;
    if (!(bid > 0)) return toast("No buyers right now. It will settle when the window closes.", "bad");
    const fee = S.fee(t.shares, bid, t.feeRate), proceeds = t.shares * bid - fee;
    Object.assign(t, { status: "sold", exit: bid, exitFee: fee, closedAt: Date.now(), pnl: proceeds - t.cost - t.fee, note: why });
    account.cash += proceeds;
    saveAccount(); saveTrades(); watchOpen();
    toast(`${why}: ${t.asset} ${tfShort(t.tf)} ${t.side} at ${cents(bid)} (${money(t.pnl, true)})`, t.pnl >= 0 ? "good" : "bad");
    render();
  }
  let settling = false;
  async function settlePaper() {
    if (settling || !isLeader()) return;
    const due = trades.filter(t => Date.now() > t.end + 4000 && (t.status === "open" || (t.official === false && (t.status === "won" || t.status === "lost"))));
    if (!due.length) return;
    settling = true;
    try {
      const results = {};
      for (const t of due) {
        results[t.id] = await D.resolve({ id: t.marketId, slug: t.slug, asset: t.asset, tf: t.tf, start: t.start, end: t.end, upToken: t.upToken || (t.side === "Up" ? t.token : null), resolutionSource: t.resolutionSource || "" });
      }
      reloadBook();
      let changed = 0;
      for (const t of trades) {
        if (!(t.id in results)) continue;
        const r = results[t.id];
        if (t.status === "open") {
          if (!r) {
            if (Date.now() > t.end + 20 * 60000) { // no result from any source after 20 minutes: refund instead of staying stuck
              Object.assign(t, { status: "void", exit: t.entry, closedAt: Date.now(), pnl: 0, note: "Refunded, no result" });
              account.cash += t.cost + t.fee; changed++;
            }
            continue;
          }
          const won = r.winner === t.side, payout = won ? t.shares : 0;
          Object.assign(t, { status: won ? "won" : "lost", exit: won ? 1 : 0, closedAt: Date.now(), pnl: payout - t.cost - t.fee, note: `Resolved ${r.winner}${r.official ? "" : " (est.)"}`, official: r.official });
          account.cash += payout; changed++;
          toast(`${t.asset} ${tfShort(t.tf)} resolved ${r.winner}${r.official ? "" : " (estimated)"}. Paper ${won ? "win" : "loss"}: ${money(t.pnl, true)}.`, won ? "good" : "bad");
        } else if (r?.official && t.official === false) {
          // already settled on an unofficial estimate — now that Polymarket has confirmed, correct it if needed
          const won = r.winner === t.side, payout = won ? t.shares : 0;
          const prevPayout = t.status === "won" ? t.shares : 0;
          if (Math.abs(payout - prevPayout) > 1e-9) {
            account.cash += payout - prevPayout;
            Object.assign(t, { status: won ? "won" : "lost", exit: won ? 1 : 0, pnl: payout - t.cost - t.fee, note: `Resolved ${r.winner} (confirmed, corrected from estimate)`, official: true });
            changed++;
            toast(`${t.asset} ${tfShort(t.tf)} correction: Polymarket confirmed ${r.winner}. Paper ${won ? "win" : "loss"}: ${money(t.pnl, true)}.`, won ? "good" : "bad");
          } else {
            t.official = true; t.note = `Resolved ${r.winner} (confirmed)`; changed++;
          }
        }
      }
      if (changed) { saveAccount(); saveTrades(); watchOpen(); render(); }
    } catch (e) { console.warn("Settlement check failed:", e.message); }
    finally { settling = false; }
  }

  /* ---------- live trading ---------- */
  async function liveBuy(m, side, source) {
    if (liveBusy) return { ok: false, msg: "Another order is in progress." };
    if (!L.canTrade()) { const msg = L.isUnlocked() ? "This account is read-only. Edit it in Settings and add the signer private key to trade." : "Unlock your live account in Settings first."; if (source !== "bot") toast(msg, "bad"); return { ok: false, msg }; }
    const token = side === "Up" ? m.upToken : m.downToken;
    const ask = D.bookFor(token).ask;
    if (!(ask > 0 && ask < 1)) { if (source !== "bot") toast(`No ${side} sellers right now.`, "bad"); return { ok: false, msg: "No sellers" }; }
    const stake = Math.min(S.stake(strategy, L.equity()), L.state.balance ?? 0);
    if (stake < 1) { const msg = `Stake ${money(stake)} is below Polymarket's $1 minimum or your cash is too low.`; if (source !== "bot") toast(msg, "bad"); return { ok: false, msg }; }
    liveBusy = true; render();
    const tried = liveTried(); tried[m.id] = Date.now(); write(K.liveTried, tried);
    try {
      const res = await L.buy({ tokenId: token, usd: stake, maxPrice: ask + S.RULES.slippage });
      toast(`${source === "bot" ? "Bot placed" : "Placed"} live buy: ${side} on ${m.asset} ${tfShort(m.tf)} for up to ${money(stake)} (${res?.status || "sent"}).`, "good");
      return { ok: true };
    } catch (e) {
      toast(`Live order failed: ${e.message}`, "bad");
      return { ok: false, msg: e.message };
    } finally { liveBusy = false; render(); }
  }
  async function liveSell(token) {
    const p = L.state.positions.find(x => String(x.assetId ?? x.tokenId) === token);
    if (!p) return;
    const bid = D.bookFor(token).bid ?? Number(p.currentPrice);
    if (!(bid > 0)) return toast("No buyers for this position right now.", "bad");
    if (!confirm(`Sell ${Number(p.currentSize).toFixed(2)} shares at market (not below ${cents(Math.max(0.01, bid - S.RULES.slippage))})?`)) return;
    liveBusy = true; render();
    try { await L.sell({ tokenId: token, shares: Number(p.currentSize), minPrice: bid - S.RULES.slippage }); toast("Live sell order placed.", "good"); }
    catch (e) { toast(`Sell failed: ${e.message}`, "bad"); }
    finally { liveBusy = false; render(); }
  }
  // bot-driven exit: same order shape as liveSell, but no confirm() dialog and its own short retry cooldown
  // so a failed sell attempt doesn't get resubmitted every tick.
  const exitTried = {};
  async function liveSellAuto(token, shares, bid, reason) {
    if (liveBusy || !(shares > 0) || Date.now() - (exitTried[token] || 0) < 8000) return;
    exitTried[token] = Date.now();
    liveBusy = true; render();
    try {
      await L.sell({ tokenId: token, shares, minPrice: Math.max(0.01, bid - S.RULES.slippage) });
      toast(`Bot sold: ${reason}`, "good");
    } catch (e) { toast(`Bot sell failed: ${e.message}`, "bad"); }
    finally { liveBusy = false; render(); }
  }
  // The strategy's own exit rule (strategy.js: exitSignal) used to be dead code — the bot only ever opened
  // trades and left every position to settle at expiry, whatever exitSignal said. This actually applies it,
  // to every open position (bot-placed or opened by hand) while the bot is on, each tick.
  function checkExits(now) {
    for (const t of openTrades()) {
      if (t.end <= now) continue; // let it settle naturally rather than race the resolver right at expiry
      const bid = D.bookFor(t.token).bid;
      const sig = S.exitSignal(strategy, { end: t.end }, t, { bid }, now);
      if (sig.ok) paperSell(t.id, sig.reason);
    }
    if (isLive() && L.canTrade() && !liveBusy) {
      const idx = tokenIndex();
      for (const p of L.state.positions) {
        const token = String(p.assetId ?? p.tokenId);
        const hit = idx.get(token);
        if (!hit || hit.m.end <= now) continue;
        const bid = D.bookFor(token).bid ?? Number(p.currentPrice);
        const sig = S.exitSignal(strategy, hit.m, { entry: Number(p.avgPrice), status: "open" }, { bid }, now);
        if (sig.ok) liveSellAuto(token, Number(p.currentSize), bid, sig.reason);
      }
    }
  }

  const buy = (m, side, source = "manual") => (isLive() ? liveBuy(m, side, source) : paperBuy(m, side, source));

  /* ---------- bot ---------- */
  function isLeader() {
    const now = Date.now(), l = read(K.leader, null);
    if (!l || l.tab === TAB || now - l.ts > 7000) { write(K.leader, { tab: TAB, ts: now }); return true; }
    return false;
  }
  const leaderElsewhere = () => { const l = read(K.leader, null); return !!l && l.tab !== TAB && Date.now() - l.ts <= 7000; };
  window.addEventListener("pagehide", () => { const l = read(K.leader, null); if (l && l.tab === TAB) localStorage.removeItem(K.leader); });

  async function tick() {
    if (!isLeader()) return;
    settlePaper();
    if (!botOn) { botNote = ""; return; }
    rollDay();
    const now = Date.now();
    checkExits(now); // manage exits for every open position first, even if entries below are paused/off
    if (!strategy.timeframes.length) { botNote = "Turn on at least one timeframe."; return; }
    const views = liveMarkets(now).map(m => vm(m, now));

    if (isLive()) {
      if (!L.canTrade()) { botNote = L.isUnlocked() ? "Paused: this account is read-only (no signer private key)." : "Waiting: unlock your live account in Settings."; return; }
      if (liveBusy) return;
      const idx = tokenIndex();
      const activePositions = L.state.positions.filter(p => { const hit = idx.get(String(p.assetId ?? p.tokenId)); return hit && hit.m.end > now; });
      const tried = liveTried();
      // orders we just placed count too, because Polymarket can take a few seconds to show the new position
      const pending = Object.keys(tried).filter(id => { const mk = D.state.markets.get(id); return mk && mk.end > now; }).length;
      const openCount = Math.max(activePositions.length + L.state.orders.length, pending);
      if (openCount >= strategy.maxOpen) { botNote = `Holding ${openCount} of ${strategy.maxOpen} live positions/orders.`; return; }
      const ready = views.filter(v => v.decision.ok && !tried[v.m.id] && !holdingFor(v.m)).sort((a, b) => a.m.end - b.m.end);
      if (!ready.length) { botNote = views.length ? `Watching ${views.length} live markets. None match right now.` : "Waiting for live markets…"; return; }
      if (account.botMode === "ask") return offer(ready);
      const stake = S.stake(strategy, L.equity());
      if ((L.state.balance ?? 0) < Math.max(1, stake)) { botNote = `Paused: cash ${money(L.state.balance)} is below your ${money(stake)} stake.`; return; }
      const r = await liveBuy(ready[0].m, ready[0].decision.side, "bot");
      botNote = r.ok ? `Placed a live order on ${ready[0].m.asset} ${tfShort(ready[0].m.tf)}.` : `Skipped ${ready[0].m.asset}: ${r.msg}`;
      return;
    }

    const open = openTrades();
    if (open.length >= strategy.maxOpen) { botNote = `Holding ${open.length} of ${strategy.maxOpen} paper positions.`; return; }
    const ready = views.filter(v => v.decision.ok && !trades.some(t => t.marketId === v.m.id)).sort((a, b) => a.m.end - b.m.end);
    if (!ready.length) { botNote = views.length ? `Watching ${views.length} live markets. None match right now.` : "Waiting for live markets…"; return; }
    if (account.botMode === "ask") return offer(ready);
    let slots = strategy.maxOpen - open.length, bought = 0, lastMsg = "";
    for (const v of ready) {
      if (slots <= 0) break;
      const r = paperBuy(v.m, v.decision.side, "bot");
      if (r.ok) { slots--; bought++; } else lastMsg = `Skipped ${v.m.asset} ${tfShort(v.m.tf)}: ${r.msg}`;
    }
    botNote = bought ? `Opened ${bought} paper position${bought > 1 ? "s" : ""}.` : lastMsg;
  }
  function offer(ready) {
    for (const v of ready) {
      if (offered.has(v.m.id)) continue;
      offered.add(v.m.id);
      toast(`${v.m.asset} ${tfShort(v.m.tf)}: ${v.decision.reason}`, "info", { label: "Review", fn: () => openSheet(v.m.id, v.decision.side) });
    }
    botNote = `${ready.length} market${ready.length > 1 ? "s match" : " matches"}. Waiting for your review.`;
  }

  function setBot(on) {
    if (on && isLive()) {
      if (!L.canTrade()) { toast(L.isUnlocked() ? "This account is read-only. Add the signer private key to trade." : "Unlock your live account before starting the bot.", "bad"); location.hash = "#settings"; return; }
      const stake = S.stake(strategy, L.equity());
      if (!confirm(`Start the LIVE bot?\n\nIt will place real market orders of about ${money(stake)} each on Polymarket, up to ${strategy.maxOpen} at a time, while this page is open.`)) return;
    }
    botOn = on; write(K.bot, on);
    if (on) { isLeader(); toast(isLive() ? "Live bot is on. Real orders will be placed." : "Paper bot is on.", "info"); }
    tick(); render();
  }
  function setMode(next) {
    if (next === mode) return;
    if (next === "live" && !L.hasVault()) { toast("Connect a Polymarket account first.", "info"); location.hash = "#settings"; return; }
    mode = next; write(K.mode, mode);
    if (botOn) { botOn = false; write(K.bot, false); toast("Bot turned off while switching accounts.", "info"); }
    if (mode === "live" && L.isUnlocked()) { L.refresh(true); toast(`Showing ${L.active()?.label || "your live account"}.`, "info"); }
    else if (mode === "live") toast("Live mode: unlock your account to load its trades.", "info");
    render();
  }
  function watchOpen() { const open = openTrades(); D.watch({ tokens: open.map(t => t.token), assets: open.map(t => t.asset) }); }

  /* ---------- rendering ---------- */
  let queued = false;
  function render() { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; draw(); }); }
  function draw() {
    rollDay();
    drawHeader(); drawAccount(); drawBot(); drawMoney();
    if (view === "home") { drawModeCard(); drawHome(); }
    if (view === "markets") drawMarkets();
    if (view === "chart") drawChartPage();
    if (view === "trades") drawTrades();
    if (view === "settings") drawSettings();
    updateSheet();
  }

  function drawHeader() {
    const s = D.state.status;
    const dot = st => (st === "live" || st === "empty" ? "good" : st === "error" ? "bad" : "warn");
    $$("[data-dot]").forEach(d => {
      const k = d.dataset.dot;
      d.className = `dot ${k === "live" ? (L.isUnlocked() ? "good" : L.hasVault() ? "warn" : "") : dot(s[k])}`;
    });
    $$("[data-mode]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    document.body.classList.toggle("mode-live", isLive());
    $$("[data-bot-toggle]").forEach(b => { b.setAttribute("aria-pressed", String(botOn)); const l = b.querySelector(".lbl"); if (l) set(l, botOn ? "Bot on" : "Bot"); });
    const banner = $("#liveBanner");
    let msg = "";
    if (isLive()) {
      if (L.state.status === "unlocking") msg = `<span>${esc(L.state.message || "Connecting…")}</span>`;
      else if (!L.isUnlocked()) msg = `<span><b>Live account is locked.</b> Unlock it to see your balance and trade.</span><a class="btn small" href="#settings">Unlock</a>`;
      else if (L.state.message) msg = `<span>${esc(L.state.message)}</span>`;
    }
    banner.hidden = !msg; html(banner, msg);
  }

  function statRow(items) { return items.map(([k, v, cls]) => `<div><dt>${esc(k)}</dt><dd class="${cls || ""}">${esc(v)}</dd></div>`).join(""); }

  function drawAccount() {
    if (isLive()) {
      const st = L.state, info = L.vaultInfo();
      set($("#equityLabel"), info ? `Live account: ${info.label}` : "Live account");
      set($("#equity"), L.isUnlocked() ? money(L.equity()) : "Locked");
      set($("#equitySub"), L.isUnlocked() ? `Updated ${st.lastRefresh ? ago(st.lastRefresh) : "…"}` : "Unlock in Settings to load your balance.");
      const posVal = st.positions.reduce((s, p) => s + Number(p.currentValue || 0), 0);
      html($("#accountStats"), statRow([["Cash", st.balance == null ? "—" : money(st.balance)], ["Positions", money(posVal)], ["Open orders", String(st.orders.length)], ["Wallet", shortAddr(info?.wallet)]]));
      return;
    }
    const eq = paperEquity(), closed = trades.filter(t => t.status !== "open"), wins = closed.filter(t => t.pnl > 0).length;
    set($("#equityLabel"), "Paper equity");
    if ($("#equity")._v != null && Math.abs($("#equity")._v - eq) >= 0.01) pulse($("#equity"), eq > $("#equity")._v ? "up" : "down");
    $("#equity")._v = eq;
    set($("#equity"), money(eq));
    const total = eq - account.startBalance;
    html($("#equitySub"), `<span class="${signClass(total)}">${money(total, true)}</span> since last reset`);
    const day = eq - account.dayStart;
    html($("#accountStats"), statRow([["Cash", money(account.cash)], ["Today", money(day, true), signClass(day)], ["Win rate", closed.length ? `${Math.round((wins / closed.length) * 100)}%` : "—"], ["Open", String(openTrades().length)]]));
  }

  function drawModeCard() {
    const info = L.vaultInfo();
    let h;
    if (isLive()) {
      h = `<div class="mode-card-text"><b class="loss">Live account: real money</b><span>${esc(info?.label || "Polymarket")}${L.isUnlocked() ? "" : " (locked)"}</span></div>
        <div class="mode-card-actions">${L.isUnlocked() ? "" : `<a class="btn small" href="#settings">Unlock</a>`}<button class="btn small ghost" data-mode="paper">Switch to Paper</button><a class="btn small ghost" href="#chart">Chart</a></div>`;
    } else {
      h = `<div class="mode-card-text"><b>Paper account: practice money</b><span>${info ? `Live account ready: ${esc(info.label)}` : "No live account connected yet"}</span></div>
        <div class="mode-card-actions">${info ? `<button class="btn small" data-mode="live">Switch to Live</button>` : `<a class="btn small" href="#settings">Connect live account</a>`}<a class="btn small ghost" href="#chart">Chart</a></div>`;
    }
    html($("#modeCard"), h);
    $("#modeCard").classList.toggle("live", isLive());
  }

  function drawBot() {
    set($("#botTitle"), botOn ? (isLive() ? "Live bot is trading" : "Paper bot is trading") : `${isLive() ? "Live" : "Paper"} bot is off`);
    let note;
    if (!botOn) note = isLive() ? "Turn it on to place real orders using your stake and timeframes." : "Turn it on to trade with paper money. It runs while this page is open.";
    else if (leaderElsewhere()) note = "Running in another open BlueEdge tab.";
    else note = botNote || "Watching for entries…";
    set($("#botNote"), note);
    $(".panel.bot").classList.toggle("on", botOn);
    $$("[data-tf]").forEach(b => b.setAttribute("aria-pressed", String(strategy.timeframes.includes(Number(b.dataset.tf)))));
    const mo = $("#maxOpenInput"); if (mo && document.activeElement !== mo && mo.value !== String(strategy.maxOpen)) mo.value = String(strategy.maxOpen);
    const openNow = isLive() ? L.state.positions.length + L.state.orders.length : openTrades().length;
    set($("#maxOpenHint"), `${openNow} open now. The bot stops opening new trades at ${strategy.maxOpen}.`);
    html($("#rulesList"), S.rulesText(strategy).map(r => `<li>${esc(r)}</li>`).join(""));
  }

  function drawMoney() {
    const obj = S.sync(strategy.risk, equity());
    $$('[data-money="risk"] input[data-m]').forEach(inp => {
      inp.closest(".money-field").classList.toggle("anchor", obj.mode === inp.dataset.m);
      if (document.activeElement === inp) return;
      const val = inp.dataset.m === "pct" ? String(+obj.pct.toFixed(2)) : obj.usd.toFixed(2);
      if (inp.value !== val) inp.value = val;
    });
    const acct = isLive() ? "live account value" : "paper equity";
    set($("#riskHint"), obj.mode === "pct" ? `Locked to ${+obj.pct.toFixed(2)}% of your ${acct}, so the dollar amount follows your balance.` : `Locked to ${money(obj.usd)} per trade, ${+obj.pct.toFixed(2)}% of your ${acct} right now.`);
  }

  function syncChips() {
    $$("[data-chips]").forEach(g => { const val = String(ui[g.dataset.chips]); $$("button", g).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === val))); });
  }

  function resetContainer(el, key) { if (el._modeKey !== key) { el.innerHTML = ""; el._nodes = null; el._html = null; el._modeKey = key; } }
  function liveRowsHtml(limit) {
    const st = L.state, idx = tokenIndex(), now = Date.now();
    const pos = st.positions.map(p => {
      const token = String(p.assetId ?? p.tokenId), d = describeToken(token, idx);
      const size = Number(p.currentSize ?? p.size ?? 0), value = Number(p.currentValue || 0), cost = Number(p.totalCostUsdc ?? size * Number(p.avgPrice || 0)), ended = d?.m ? d.m.end <= now : !!p.redeemable;
      return `<div class="pos tappable" data-live-pos="${esc(token)}">${coinBadge(d?.asset || symFromTitle(p.title))}<div class="pos-main"><b>${esc(d?.label || p.title || p.outcome || shortAddr(token))}</b><span>${size.toFixed(2)} shares, avg ${cents(Number(p.avgPrice))}, now ${cents(Number(p.currentPrice))}</span></div>
        <div class="pos-pnl"><b class="${signClass(value - cost)}">${money(value - cost, true)}</b><span>${money(value)}</span></div>
        ${d && !ended ? `<button class="btn small" data-live-sell="${esc(token)}">Sell</button>` : `<span class="tag">${ended ? "Resolved" : "Held"}</span>`}</div>`;
    });
    const ords = st.orders.map(o => {
      const d = describeToken(o.assetId ?? o.tokenId, idx);
      return `<div class="pos tappable" data-live-order="${esc(o.id)}">${coinBadge(d?.asset || "?")}<div class="pos-main"><b>${esc(o.side)} ${esc(d?.label || o.outcome || "Order")}</b><span>${Number(o.sizeMatched || 0).toFixed(2)} of ${Number(o.originalSize || 0).toFixed(2)} filled at ${cents(Number(o.price))}</span></div>
        <div class="pos-pnl"><b>${money(Number(o.originalSize || 0) * Number(o.price || 0))}</b><span>open order</span></div><button class="btn small" data-cancel="${esc(o.id)}">Cancel</button></div>`;
    });
    return { pos: limit ? pos.slice(0, limit) : pos, ords, count: pos.length + ords.length };
  }
  function drawHomeOpen() {
    const box = $("#homeOpen");
    if (isLive()) {
      resetContainer(box, "live");
      const r = L.isUnlocked() ? liveRowsHtml(6) : { pos: [], ords: [], count: 0 };
      $("#homeOpenBlock").hidden = !r.count;
      set($("#homeOpenTitle"), `Open on your live account (${r.count})`);
      html(box, [...r.ords, ...r.pos].join(""));
    } else {
      resetContainer(box, "paper");
      const open = openTrades();
      $("#homeOpenBlock").hidden = !open.length;
      set($("#homeOpenTitle"), `Open paper trades (${open.length})`);
      keyed(box, open, t => t.id, createPos, updatePos, "");
    }
  }
  function drawHome() {
    drawHomeOpen();
    syncChips();
    const now = Date.now();
    const list = liveMarkets(now).filter(m => ui.homeTf === "all" || m.tf === Number(ui.homeTf)).map(m => vm(m, now))
      .sort((a, b) => (b.decision.ok - a.decision.ok) || a.m.end - b.m.end).slice(0, 6);
    keyed($("#homeMarkets"), list, v => v.m.id, createCard, updateCard, marketsEmpty());
  }

  function drawMarkets() {
    syncChips();
    const now = Date.now();
    let list;
    if (ui.marketsWhen === "next") {
      const next = new Map();
      for (const m of D.markets()) { if (m.start <= now) continue; const k = `${m.asset}:${m.tf}`; if (!next.has(k) || next.get(k).start > m.start) next.set(k, m); }
      list = [...next.values()];
    } else if (ui.marketsWhen === "resolved") list = D.markets().filter(m => m.end <= now);
    else list = liveMarkets(now);
    list = list.filter(m => ui.marketsTf === "all" || m.tf === Number(ui.marketsTf)).map(m => vm(m, now))
      .sort(ui.marketsWhen === "resolved" ? (a, b) => b.m.end - a.m.end : (a, b) => (b.decision.ok - a.decision.ok) || a.m.end - b.m.end).slice(0, 80);
    const live = liveMarkets(now), assets = new Set(live.map(m => m.asset));
    set($("#marketsCaption"), D.state.status.lastDiscovery ? `${live.length} live markets across ${assets.size} coin${assets.size === 1 ? "" : "s"}. ${list.filter(v => v.decision.ok).length} match the bot's rules.` : "Finding markets…");
    keyed($("#allMarkets"), list, v => v.m.id, createCard, updateCard, marketsEmpty());
  }

  /* chart page */
  let chartMounted = false;
  function chartCoins() {
    const order = ["BTC", "ETH", "SOL", "XRP"];
    const rank = a => { const i = order.indexOf(a); return i < 0 ? 99 : i; };
    const found = [...new Set(D.markets().map(m => m.asset))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return found.length ? found : order;
  }
  function drawChartPage() {
    if (!chartMounted) {
      C.mount($("#chartHost"), $("#chartLegend"), $("#chartStatus"));
      html($("#chartIntervals"), C.INTERVALS.map(iv => `<button data-interval="${iv}">${iv}</button>`).join(""));
      chartMounted = true;
    }
    const coins = chartCoins();
    if (!coins.includes(ui.chartCoin)) ui.chartCoin = coins[0];
    html($("#chartCoins"), coins.map(c => `<button data-coin="${esc(c)}">${esc(c)}</button>`).join(""));
    $$("#chartCoins button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.coin === ui.chartCoin)));
    $$("#chartIntervals button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.interval === ui.chartInterval)));
    if (C.symbol !== ui.chartCoin + "USDT" || C.interval !== ui.chartInterval) { chartLineKey = ""; C.load(ui.chartCoin, ui.chartInterval).then(() => { chartLineKey = ""; applyChartLine(); }); }
    else applyChartLine();
    set($("#chartMarketsTitle"), `${coinName(ui.chartCoin)} markets on Polymarket`);
    const now = Date.now();
    const list = liveMarkets(now).filter(m => m.asset === ui.chartCoin).sort((a, b) => a.tf - b.tf).map(m => vm(m, now));
    keyed($("#chartMarkets"), list, v => v.m.id, createChartRow, updateChartRow, `<p>No live Polymarket markets for ${esc(ui.chartCoin)} right now.</p>`);
  }
  function createChartRow(v) {
    const el = document.createElement("div");
    el.className = "pos chart-row"; el.dataset.chartMarket = v.m.id;
    el.innerHTML = `${coinBadge(v.m.asset)}<div class="pos-main"><b>${S.tfName(v.m.tf)} window</b><span data-f="sub"></span></div>
      <div class="pos-pnl"><b data-f="odds"></b><span data-f="left"></span></div><button class="btn small" data-open-sheet="${esc(v.m.id)}">Trade</button>`;
    return el;
  }
  function updateChartRow(el, v) {
    set(field(el, "sub"), v.ctx.shownOpen != null ? `To beat ${fmtPrice(v.ctx.shownOpen)}${v.move != null ? `, ${v.move >= 0 ? "+" : "−"}${(Math.abs(v.move) * 100).toFixed(3)}%` : ""}` : "To beat —");
    set(field(el, "odds"), `Up ${cents(v.ctx.up.ask)} / Down ${cents(v.ctx.down.ask)}`);
    set(field(el, "left"), `${clock(v.left)} left`);
    el.classList.toggle("selected", (Number(ui.chartPtbTf) || 5) === v.m.tf);
  }
  let chartLineKey = "";
  function applyChartLine() {
    const tf = Number(ui.chartPtbTf) || 5, now = Date.now();
    const m = D.markets().find(x => x.asset === ui.chartCoin && x.tf === tf && x.start <= now && x.end > now);
    const ptb = m ? D.priceToBeat(m) : null;
    const shown = ptb?.exact ? ptb.price : (ptb?.estPrice ?? null);
    const isEst = !ptb?.exact && shown != null;
    const key = m && shown != null ? `${m.id}:${shown}:${isEst ? "est" : "final"}` : "";
    if (key === chartLineKey) return;
    chartLineKey = key;
    if (!key) { C.clearPriceLine(); return; }
    C.setPriceLine(shown, `${tfShort(tf)} to beat${isEst ? " (est.)" : ""}`, isEst);
  }

  /* positions */
  function createPos(t) {
    const el = document.createElement("div");
    el.className = "pos tappable";
    el.dataset.paperTrade = t.id;
    el.innerHTML = `${coinBadge(t.asset)}<div class="pos-main"><b>${esc(t.asset)} ${tfShort(t.tf)} <em class="${t.side === "Up" ? "gain" : "loss"}">${esc(t.side)}</em></b><span data-f="sub"></span></div>
      <div class="pos-pnl"><b data-f="pnl"></b><span data-f="left"></span></div><button class="btn small" data-sell="${t.id}">Sell</button>`;
    return el;
  }
  function updatePos(el, t) {
    const now = Date.now(), bid = D.bookFor(t.token).bid, pnl = t.shares * (bid ?? t.entry) - t.cost - t.fee;
    set(field(el, "sub"), `${t.shares.toFixed(2)} at ${cents(t.entry)}, now ${cents(bid)}`);
    const p = field(el, "pnl"); set(p, money(pnl, true)); p.className = signClass(pnl);
    set(field(el, "left"), t.end > now ? `${clock(t.end - now)} left` : "Settling…");
    el.querySelector("[data-sell]").disabled = t.end <= now;
  }

  function drawTrades() {
    const live = isLive();
    $("#paperTrades").hidden = live; $("#liveTrades").hidden = !live;
    if (live) return drawLiveTrades();
    const closed = trades.filter(t => t.status !== "open");
    const realized = closed.reduce((s, t) => s + (t.pnl || 0), 0), wins = closed.filter(t => t.pnl > 0).length;
    const r = $("#tRealized"); set(r, money(realized, true)); r.className = signClass(realized);
    set($("#tWinRate"), closed.length ? `${Math.round((wins / closed.length) * 100)}%` : "—");
    set($("#tCount"), String(closed.length));
    set($("#tFees"), money(trades.reduce((s, t) => s + (t.fee || 0) + (t.exitFee || 0), 0)));
    keyed($("#openPositions"), openTrades(), t => t.id, createPos, updatePos, `<p>No open paper positions.</p>`);
    const sig = closed.map(t => t.id + t.status).join("|"), hist = $("#history");
    if (hist._sig !== sig) {
      hist._sig = sig;
      hist.innerHTML = closed.length ? closed.slice().reverse().slice(0, 200).map(t => `
        <div class="hrow tappable" data-paper-trade="${t.id}">${coinBadge(t.asset, "sm")}
          <div class="h-main"><b>${esc(t.asset)} ${tfShort(t.tf)} ${esc(t.side)}</b><span>${new Date(t.openedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. ${cents(t.entry)} → ${cents(t.exit)}</span></div>
          <span class="tag ${t.status}">${t.status === "won" ? "Won" : t.status === "lost" ? "Lost" : esc(t.note || "Sold")}</span>
          <b class="h-pnl ${signClass(t.pnl)}">${money(t.pnl, true)}</b></div>`).join("") : `<div class="empty"><p>Closed paper trades show up here.</p></div>`;
      drawEquityChart();
    }
  }

  function describeToken(token, idx) {
    const hit = idx.get(String(token));
    return hit ? { asset: hit.m.asset, label: `${hit.m.asset} ${tfShort(hit.m.tf)} ${hit.side}`, m: hit.m } : null;
  }
  function drawLiveTrades() {
    const st = L.state;
    if (!L.isUnlocked()) {
      const msg = `<div class="empty"><p>${L.hasVault() ? "Unlock your live account to load orders." : "Connect a Polymarket account in Settings."}</p><a class="btn small" href="#settings">Go to Settings</a></div>`;
      ["#liveOrders", "#livePositions", "#liveFills", "#liveClosed"].forEach(x => html($(x), msg));
      set($("#lBalance"), "—"); set($("#lPosValue"), "—"); set($("#lOrderCount"), "0"); set($("#lRealized"), "—"); set($("#lUpdated"), "");
      $("#cancelAllBtn").disabled = true;
      return;
    }
    const idx = tokenIndex();
    set($("#lBalance"), st.balance == null ? "—" : money(st.balance));
    set($("#lPosValue"), money(st.positions.reduce((s, p) => s + Number(p.currentValue || 0), 0)));
    set($("#lOrderCount"), String(st.orders.length));
    set($("#lUpdated"), st.lastRefresh ? `Updated ${ago(st.lastRefresh)}` : "");
    $("#cancelAllBtn").disabled = !st.orders.length;

    const r = liveRowsHtml(0);
    html($("#liveOrders"), r.ords.length ? r.ords.join("") : `<div class="empty"><p>No open orders. Bot orders fill immediately or cancel, so they rarely stay open.</p></div>`);
    html($("#livePositions"), r.pos.length ? r.pos.join("") : `<div class="empty"><p>No open positions. Polymarket redeems winning positions to your cash automatically.</p></div>`);
    const realized = st.closed.reduce((sum, c) => sum + Number(c.realizedPnl || 0), 0);
    const rl = $("#lRealized"); set(rl, st.closed.length ? money(realized, true) : "—"); rl.className = signClass(realized);
    html($("#liveClosed"), st.closed.length ? st.closed.map((c, i) => {
      const pnl = Number(c.realizedPnl || 0), d = describeToken(c.assetId, idx);
      return `<div class="hrow tappable" data-live-closed="${i}">${coinBadge(d?.asset || symFromTitle(c.title), "sm")}<div class="h-main"><b>${esc(c.title || d?.label || "Position")}</b><span>${esc(when(toMs(c.timestamp)))}${c.outcome ? `. ${esc(c.outcome)}` : ""}, avg ${cents(Number(c.avgPrice))}</span></div>
        <span class="tag ${pnl >= 0 ? "won" : "lost"}">${pnl >= 0 ? "Profit" : "Loss"}</span><b class="h-pnl ${signClass(pnl)}">${money(pnl, true)}</b></div>`;
    }).join("") : `<div class="empty"><p>No closed positions yet.</p></div>`);
    html($("#liveFills"), st.trades.length ? st.trades.slice(0, 100).map((t, i) => {
      const d = describeToken(t.assetId ?? t.tokenId ?? t.asset_id, idx);
      const ms = toMs(t.matchTime || t.createdAt || t.timestamp);
      return `<div class="hrow tappable" data-live-fill="${i}">${coinBadge(d?.asset || "?", "sm")}<div class="h-main"><b>${esc(t.side || "")} ${esc(d?.label || t.outcome || "Fill")}</b><span>${ms ? esc(when(ms)) + ". " : ""}${Number(t.size || 0).toFixed(2)} at ${cents(Number(t.price))}</span></div>
        <span class="tag">${esc(String(t.status || "filled").replace("TRADE_STATUS_", "").toLowerCase())}</span><b class="h-pnl">${money(Number(t.size || 0) * Number(t.price || 0))}</b></div>`;
    }).join("") : `<div class="empty"><p>No fills yet.</p></div>`);
  }

  function drawEquityChart() {
    const c = $("#equityCanvas");
    const closed = trades.filter(t => t.status !== "open" && t.closedAt).sort((a, b) => a.closedAt - b.closedAt);
    $("#chartEmpty").hidden = closed.length > 0; c.hidden = !closed.length;
    if (!closed.length) return;
    let eq = account.startBalance;
    const pts = [eq, ...closed.map(t => (eq += t.pnl || 0))];
    const dpr = window.devicePixelRatio || 1, w = c.clientWidth || 600, h = c.clientHeight || 200;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    const min = Math.min(...pts), max = Math.max(...pts), pad = 16;
    const x = i => pad + (i / Math.max(1, pts.length - 1)) * (w - pad * 2);
    const y = v => h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);
    const up = pts[pts.length - 1] >= account.startBalance, color = up ? "#2ECF8E" : "#FF6F7D";
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, up ? "rgba(46,207,142,.28)" : "rgba(255,111,125,.28)"); grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.beginPath(); pts.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)))); ctx.lineTo(x(pts.length - 1), h); ctx.lineTo(x(0), h); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath(); pts.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)))); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
  }

  /* settings: live accounts */
  let revealed = null, revealTimer = null, submitting = false, panelMode = null, editPrefill = null, unlockedPasscode = null;
  const WT = L.WALLET_TYPES;
  const secretInput = (name, label, placeholder, help, value = "") => `<label class="field"><span>${label}</span><div class="reveal-wrap"><input type="password" name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"><button type="button" class="eye" data-eye>Show</button></div>${help ? `<small>${help}</small>` : ""}</label>`;
  const textInput = (name, label, placeholder, help, value = "") => `<label class="field"><span>${label}</span><input type="text" name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">${help ? `<small>${help}</small>` : ""}</label>`;

  function accountFormHtml(p) {
    const editing = !!p?.id;
    return `<form id="accountForm" autocomplete="off" novalidate>
      <div class="block-head"><h3>${editing ? "Edit account" : "Add a Polymarket account"}</h3><button type="button" class="btn ghost small" data-action="cancel-form">Cancel</button></div>
      ${editing ? `<input type="hidden" name="id" value="${esc(p.id)}">` : ""}
      <label class="toggle-row"><input type="checkbox" data-show-all> Show everything I type</label>
      ${textInput("label", "Account name", "My Polymarket", "", p?.label)}
      ${textInput("wallet", "Polymarket wallet address", "0x…", "From your profile menu on polymarket.com. It's the address that holds your pUSD.", p?.wallet)}
      <label class="field"><span>Wallet type</span><select name="walletType">${[3, 2, 1, 0].map(v => `<option value="${v}" ${Number(p?.walletType ?? 3) === v ? "selected" : ""}>${WT[v]}${v === 3 ? " (most accounts since 2026)" : v === 2 ? " (browser wallet login)" : v === 1 ? " (older email login)" : ""}</option>`).join("")}</select><small>Used for read-only balance checks. Trading detects it automatically.</small></label>
      <p class="form-section">L1 signer: needed to place orders</p>
      ${secretInput("privateKey", "Signer private key", "0x… (64 hex characters)", "This is not the API key, secret or passphrase. Leave it empty for a read-only account.", p?.privateKey)}
      ${textInput("signer", "Signer address", "0x…", "The Signer Address shown next to your API keys. Filled in from the private key if you leave it empty.", p?.signer)}
      <p class="form-section">L2 CLOB API credentials <em class="opt">optional with a private key</em></p>
      ${textInput("apiKey", "API key", "01a0a9e4-0d88-…", "", p?.apiKey)}
      ${secretInput("apiSecret", "API secret", "", "", p?.apiSecret)}
      ${secretInput("apiPassphrase", "API passphrase", "", "With a private key you can leave these empty and they're created automatically. Builder API keys are a different thing and won't work here.", p?.apiPassphrase)}
      <p class="form-section">Relayer <em class="opt">optional</em></p>
      ${secretInput("relayerKey", "Relayer API key", "", "Lets BlueEdge set up trading approvals without gas.", p?.relayerKey)}
      ${textInput("relayerAddress", "Relayer address", "0x…", "", p?.relayerAddress)}
      <p class="form-section">Protect this account</p>
      ${secretInput("passcode", "Passcode", "At least 8 characters", editing ? "Already filled in from unlocking above. Change it here only if you want a new one." : "You'll type this to unlock the account.", p?.passcode || "")}
      ${secretInput("passcode2", "Confirm passcode", "", "", p?.passcode || "")}
      <button class="btn primary big" type="submit">${editing ? "Save changes" : "Save account"}</button>
      <p class="hint">Saving works even when Polymarket can't be reached. Keys are encrypted and stay on this device.</p>
    </form>`;
  }

  function revealHtml(a) {
    if (revealed && revealed.id === a.id) {
      const row = (label, value) => value ? `<div class="secret"><span>${esc(label)}</span><code>${esc(value)}</code><button class="btn small" data-copy="${esc(value)}">Copy</button></div>` : "";
      return `<div class="secrets">
        ${row("Wallet address", revealed.wallet)}
        <div class="secret"><span>Wallet type</span><code>${esc(WT[revealed.walletType] || revealed.walletType)}</code></div>
        ${row("Signer address", revealed.signer)}
        ${row("Signer private key", revealed.privateKey) || `<div class="secret"><span>Signer private key</span><code>Not saved (read-only)</code></div>`}
        ${row(`CLOB API key${revealed.credsSource ? ` (${revealed.credsSource})` : ""}`, revealed.apiKey)}
        ${row("CLOB API secret", revealed.apiSecret)}
        ${row("CLOB API passphrase", revealed.apiPassphrase)}
        ${row("Relayer API key", revealed.relayerKey)}
        ${row("Relayer address", revealed.relayerAddress)}
        <div class="btn-row"><button class="btn" data-action="edit-account">Edit account</button><button class="btn ghost" data-action="hide-secrets">Hide</button></div>
        <p class="hint">Hidden again in 2 minutes.</p>
      </div>`;
    }
    // Already typed the passcode once to unlock this session: don't ask again, just reveal on tap.
    if (unlockedPasscode && L.state.activeId === a.id && L.isUnlocked()) return `<button class="btn ghost" data-action="reveal-now">View or edit all keys</button>`;
    return `<form id="revealForm" autocomplete="off" novalidate class="reveal-form">
      ${secretInput("passcode", "Passcode to view or edit keys", "", "")}
      <button class="btn ghost" type="submit">View all keys and addresses</button>
    </form>`;
  }

  function checksHtml() {
    const st = L.state;
    if (!st.checks.length && !st.checking) return "";
    const icon = ok => ok === true ? "✓" : ok === false ? "✕" : "?";
    return `<ul class="check-list">${st.checks.map(c => `<li class="${c.ok === true ? "ok" : c.ok === false ? "bad" : "unknown"}"><i>${icon(c.ok)}</i><div><b>${esc(c.name)}</b><span>${esc(c.detail || "")}</span></div></li>`).join("")}${st.checking ? `<li class="unknown"><i class="loader tiny"></i><div><b>Checking…</b></div></li>` : ""}</ul>`;
  }

  function activeHtml() {
    const a = L.active(); if (!a) return "";
    const st = L.state;
    if (!L.isUnlocked()) return `<div class="acct-detail">
      <h4>${esc(a.label)}</h4>
      <form id="unlockForm" autocomplete="off" novalidate>
        ${secretInput("passcode", "Passcode", "", "")}
        ${st.message && st.status !== "unlocking" ? `<p class="form-error">${esc(st.message)}</p>` : ""}
        <button class="btn primary big" type="submit">${st.status === "unlocking" ? esc(st.message || "Unlocking…") : "Unlock"}</button>
      </form>
      ${revealHtml(a)}
    </div>`;
    const acct = st.account || {};
    return `<div class="acct-detail">
      <h4>${esc(a.label)} <span class="tag ${st.canTrade ? "won" : ""}">${st.canTrade ? "Unlocked, can trade" : "Unlocked, read-only"}</span></h4>
      ${st.message ? `<p class="notice">${esc(st.message)}</p>` : ""}
      <dl class="kv plain">
        <div><dt>Cash</dt><dd>${st.balance == null ? (st.refreshing ? "Loading…" : "—") : esc(money(st.balance))}</dd></div>
        <div><dt>Mode</dt><dd>${st.mode === "sdk" ? "L1 + L2" : "L2 read-only"}</dd></div>
        <div><dt>Wallet</dt><dd class="copyable" data-copy="${esc(a.wallet)}">${esc(shortAddr(a.wallet))}</dd></div>
        <div><dt>Signer</dt><dd class="copyable" data-copy="${esc(acct.signer || a.signer || "")}">${esc(shortAddr(acct.signer || a.signer))}</dd></div>
        <div><dt>Wallet type</dt><dd>${esc(WT[acct.walletType] ?? String(acct.walletType ?? "—"))}</dd></div>
        <div><dt>Updated</dt><dd>${st.lastRefresh ? esc(ago(st.lastRefresh)) : "—"}</dd></div>
      </dl>
      <div class="btn-row">
        <button class="btn primary" data-action="check-account" ${st.checking ? "disabled" : ""}>Check balance and connection</button>
        <button class="btn ghost" data-action="lock">Lock</button>
      </div>
      ${checksHtml()}
      ${st.approvalsMissing && a.hasRelayer ? `<button class="btn" data-action="setup-approvals">Set up trading approvals</button>` : ""}
      ${revealHtml(a)}
    </div>`;
  }

  function livePanelHtml() {
    if (panelMode) return accountFormHtml(editPrefill);
    const all = L.list(), act = L.state.activeId;
    const rowsHtml = all.length ? `<div class="acct-list">${all.map(a => `<div class="acct ${a.id === act ? "active" : ""}">
        <div class="acct-main"><b>${esc(a.label)}</b><span>${esc(shortAddr(a.wallet))}, ${a.hasKey ? "can trade" : "read-only"}${a.id === act ? (L.isUnlocked() ? ", unlocked" : ", locked") : ""}</span></div>
        <div class="acct-actions">${a.id === act ? `<span class="tag">In use</span>` : `<button class="btn small" data-use-account="${esc(a.id)}">Use</button>`}<button class="btn small ghost danger-text" data-remove-account="${esc(a.id)}">Remove</button></div>
      </div>`).join("")}</div>` : `<p class="hint" style="margin-top:0">No live accounts yet. Add one to trade real money. Paper mode never needs an account.</p>`;
    return `<div class="block-head"><h3>Live accounts</h3></div>
      ${rowsHtml}
      <div class="btn-row">
        <button class="btn primary" data-action="add-account">Add account</button>
        <button class="btn ghost" data-action="import-account">Load file</button>
        ${all.length ? `<button class="btn ghost" data-action="export-account">Save all to file</button>` : ""}
      </div>
      ${activeHtml()}`;
  }

  function drawSettings() {
    const panel = $("#livePanel"), st = L.state;
    const sig = panelMode ? `form|${panelMode}|${editPrefill?.id || ""}` :
      [st.status, st.message, L.isUnlocked(), st.canTrade, st.balance, st.refreshing, st.stream, st.activeId, st.approvalsMissing, st.checking, JSON.stringify(st.checks), revealed?.id || "", Math.floor((Date.now() - st.lastRefresh) / 10000), JSON.stringify(L.list())].join("|");
    const typing = panel.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName);
    if (panel._sig !== sig && !typing && !submitting) { panel.innerHTML = livePanelHtml(); panel._sig = sig; }
    $$("[data-seg='botMode'] button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === account.botMode)));
    const sb = $("#startInput"); if (document.activeElement !== sb && !sb.value) sb.value = String(Math.round(account.cash * 100) / 100);
    const rs = $("#refreshSelect"); if (rs.value !== String(account.refreshSec)) rs.value = String(account.refreshSec);
    const s = D.state.status, now = Date.now();
    const perMin = s.requestLog.filter(t => now - t < 60000).length;
    const label = x => ({ live: "Connected", empty: "Connected", loading: "Loading", connecting: "Connecting", reconnecting: "Reconnecting", error: "Error", idle: "Locked", offline: "Off" }[x] || x);
    const cls = x => (x === "live" || x === "empty" ? "good" : x === "error" ? "bad" : x === "offline" ? "" : "warn");
    const rows = [
      [s.gamma, "Polymarket markets", s.lastDiscovery ? `${s.gammaMsg}. Checked ${Math.round((now - s.lastDiscovery) / 1000)}s ago, ${perMin} request${perMin === 1 ? "" : "s"} in the last minute.` : s.gammaMsg || "Starting up"],
      [s.poly, "Polymarket order books", `${s.polyTokens} outcome prices streaming, with a REST refresh for any that go quiet.`],
      [s.chainlink, "Polymarket oracle feed", "The Chainlink price feed that Polymarket itself resolves 5, 15 and 60 minute markets on."],
      [D.state.ptbCheck?.checked ? (D.state.ptbCheck.matched < D.state.ptbCheck.checked ? "warn" : "live") : "connecting", "Polymarket price to beat",
        D.state.ptbCheck?.checked
          ? `Reconstructed in real time from Polymarket's own oracle feed for ${D.state.ptbCheck.checked} window${D.state.ptbCheck.checked === 1 ? "" : "s"} so far${D.state.ptbCheck.matched < D.state.ptbCheck.checked ? `; ${D.state.ptbCheck.checked - D.state.ptbCheck.matched} corrected once Polymarket published its own value` : ", confirmed against Polymarket's own value where published"}.`
          : "Capturing Polymarket's oracle feed at each window's open — live markets will show a price to beat as soon as one opens."],
      [s.binance, "Binance feed", s.binanceHost ? `Using ${s.binanceHost}. Falls back to other Binance hosts automatically.` : "Starts once markets are found."],
      [L.isUnlocked() ? (L.canTrade() && L.state.stream !== "live" ? "connecting" : "live") : L.hasVault() ? "idle" : "offline", "Live account", L.isUnlocked() ? (L.canTrade() ? "L1 + L2 connected. Updates stream from Polymarket, with a backup refresh every 20 seconds." : "L2 read-only. Balance and orders refresh every 15 seconds.") : L.hasVault() ? "Saved and locked." : "Not connected."]
    ];
    html($("#connList"), rows.map(([x, name, detail]) => `<li><i class="dot ${cls(x)}"></i><div><b>${name}</b> <span class="tag-lite">${label(x)}</span><p>${esc(detail)}</p></div></li>`).join(""));
  }

  /* ---------- toasts ---------- */
  function toast(msg, kind = "info", action) {
    const box = $("#toasts"), el = document.createElement("div");
    el.className = `toast ${kind}`;
    const span = document.createElement("span"); span.textContent = msg; el.append(span);
    if (action) { const b = document.createElement("button"); b.textContent = action.label; b.onclick = () => { action.fn(); el.remove(); }; el.append(b); }
    box.append(el);
    while (box.children.length > 3) box.firstElementChild.remove();
    const life = action ? 9000 : kind === "bad" ? 6000 : 3800;
    setTimeout(() => el.classList.add("out"), life);
    setTimeout(() => el.remove(), life + 350);
  }

  /* ---------- routing ---------- */
  function route() {
    const v = location.hash.slice(1), prev = view;
    view = TITLES[v] ? v : "home";
    $$("[data-view]").forEach(s => { s.hidden = s.dataset.view !== view; });
    $$(".nav a").forEach(a => (a.getAttribute("href") === "#" + view ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    set($("#pageTitle"), TITLES[view]);
    document.title = `${TITLES[view]} · BlueEdge`;
    if (prev === "chart" && view !== "chart") C.pause();
    if (view === "chart" && prev !== "chart" && chartMounted) C.resume();
    closeSheet(); window.scrollTo(0, 0);
    if (isLive() && L.isUnlocked() && (view === "trades" || view === "home")) L.refresh(false);
    draw();
  }

  /* ---------- events ---------- */
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast("Copied.", "info"); }
    catch { toast("Couldn't copy on this browser.", "bad"); }
  }

  document.addEventListener("click", async e => {
    const t = e.target, q = sel => t.closest(sel);
    const ext = t.closest('a[href^="https://polymarket.com/"]');
    if (ext) { e.preventDefault(); const w = window.open(ext.href, "_blank", "noopener"); if (!w) location.href = ext.href; return; }
    let el;
    if ((el = q("[data-copy]"))) return copy(el.dataset.copy);
    if ((el = q("[data-sell]"))) { e.stopPropagation(); return paperSell(el.dataset.sell); }
    if ((el = q("[data-live-sell]"))) return liveSell(el.dataset.liveSell);
    if ((el = q("[data-sell-market]"))) {
      const m = D.state.markets.get(el.dataset.sellMarket), held = m && holdingFor(m);
      if (!held) return;
      return isLive() ? liveSell(held.token) : paperSell(held.id);
    }
    if ((el = q("[data-cancel]"))) {
      el.disabled = true;
      try { await L.cancel(el.dataset.cancel); toast("Order cancelled.", "good"); if (el.closest("#sheet")) closeSheet(); } catch (err) { toast(err.message, "bad"); el.disabled = false; }
      return;
    }
    if ((el = q("[data-mode]"))) return setMode(el.dataset.mode);
    if ((el = q("[data-paper-trade]"))) return paperDetail(el.dataset.paperTrade);
    if ((el = q("[data-live-pos]"))) return livePositionDetail(el.dataset.livePos);
    if ((el = q("[data-live-order]"))) return liveOrderDetail(el.dataset.liveOrder);
    if ((el = q("[data-live-fill]"))) return liveFillDetail(Number(el.dataset.liveFill));
    if ((el = q("[data-live-closed]"))) return liveClosedDetail(Number(el.dataset.liveClosed));
    if ((el = q("[data-eye]"))) { const inp = el.previousElementSibling; inp.type = inp.type === "password" ? "text" : "password"; el.textContent = inp.type === "password" ? "Show" : "Hide"; return; }
    if ((el = q("[data-use-account]"))) { if (botOn && isLive()) { botOn = false; write(K.bot, false); } revealed = null; unlockedPasscode = null; await L.setActive(el.dataset.useAccount); toast("Account selected. Unlock it with its passcode.", "info"); return render(); }
    if ((el = q("[data-remove-account]"))) {
      const acc = L.list().find(x => x.id === el.dataset.removeAccount);
      if (!acc || !confirm(`Remove "${acc.label}" from this device?\n\nSave all accounts to a file first if you want to load it again later.`)) return;
      if (acc.id === L.state.activeId && isLive()) { botOn = false; write(K.bot, false); }
      revealed = null; await L.remove(acc.id);
      if (!L.hasVault() && isLive()) { mode = "paper"; write(K.mode, mode); }
      toast(`Removed ${acc.label}.`, "info"); return render();
    }
    if ((el = q("[data-coin]"))) { ui.chartCoin = el.dataset.coin; chartLineKey = ""; saveUi(); return draw(); }
    if ((el = q("[data-interval]"))) { ui.chartInterval = el.dataset.interval; ui.chartPtbTf = IV_TO_TF[ui.chartInterval] || ui.chartPtbTf; chartLineKey = ""; saveUi(); return draw(); }
    if ((el = q("[data-open-sheet]"))) return openSheet(el.dataset.openSheet);
    if ((el = q("[data-chart-market]"))) { const mk = D.state.markets.get(el.dataset.chartMarket); if (mk) { ui.chartPtbTf = mk.tf; saveUi(); chartLineKey = ""; applyChartLine(); } return draw(); }

    const action = q("[data-action]")?.dataset.action;
    switch (action) {
      case "refresh":
        if (Date.now() - D.state.status.lastDiscovery < 10000) toast("Markets were refreshed a moment ago.", "info");
        else {
          D.resetBackoff();                     // clear any stuck proxy/rate-limit backoff so this actually retries now
          D.refreshPriceToBeat();
          D.discover();
          toast("Checking Polymarket for markets and price-to-beat…", "info");
        }
        return;
      case "live-refresh": L.refresh(false); toast("Refreshing your live account…", "info"); return;
      case "close-sheet": return closeSheet();
      case "sheet-buy": {
        if (!sheet) return;
        const m = D.state.markets.get(sheet.id);
        const side = sheet.side || vm(m).decision.side || "Up";
        const r = await buy(m, side, "manual");
        if (r?.ok) closeSheet();
        return;
      }
      case "sheet-chart": {
        if (!sheet) return;
        const m = D.state.markets.get(sheet.id);
        ui.chartCoin = m.asset; ui.chartPtbTf = m.tf; chartLineKey = "";
        ui.chartInterval = { 5: "1m", 15: "1m", 60: "5m" }[m.tf] || ui.chartInterval;
        saveUi(); closeSheet(); location.hash = "#chart"; return;
      }
      case "import-account": return $("#accountFile").click();
      case "export-account": try { const n = L.exportFile(); toast(`Saved ${n} encrypted account${n === 1 ? "" : "s"} to a JSON file on this device.`, "good"); } catch (err) { toast(err.message, "bad"); } return;
      case "lock":
        if (botOn && isLive()) { botOn = false; write(K.bot, false); }
        revealed = null; unlockedPasscode = null; await L.lock(); toast("Live account locked.", "info"); return render();
      case "hide-secrets": revealed = null; clearTimeout(revealTimer); $("#livePanel")._sig = null; return render();
      case "reveal-now":
        try { revealed = { ...(await L.reveal(L.state.activeId, unlockedPasscode)), passcode: unlockedPasscode }; clearTimeout(revealTimer); revealTimer = setTimeout(() => { revealed = null; $("#livePanel")._sig = null; render(); }, 120000); }
        catch (err) { toast(err.message, "bad"); }
        $("#livePanel")._sig = null; return render();
      case "add-account": panelMode = "add"; editPrefill = null; revealed = null; $("#livePanel")._sig = null; draw(); $("#livePanel").scrollIntoView({ block: "start", behavior: "smooth" }); return;
      case "edit-account": if (!revealed) return; panelMode = "edit"; editPrefill = revealed; $("#livePanel")._sig = null; draw(); $("#livePanel").scrollIntoView({ block: "start", behavior: "smooth" }); return;
      case "cancel-form": panelMode = null; editPrefill = null; $("#livePanel")._sig = null; return draw();
      case "check-account": try { toast("Checking your account…", "info"); await L.check(); const bad = L.state.checks.filter(c => c.ok === false).length; toast(bad ? `${bad} check${bad > 1 ? "s" : ""} need attention.` : "Everything checked out.", bad ? "bad" : "good"); } catch (err) { toast(err.message, "bad"); } return;
      case "setup-approvals": try { toast("Setting up trading approvals…", "info"); await L.setupApprovals(); toast("Trading approvals submitted. Run the check again in a minute.", "good"); } catch (err) { toast(err.message, "bad"); } return;
    }

    if ((el = q(".sheet .side")) && sheet) { sheet.side = el.dataset.side; return updateSheet(); }
    if ((el = q(".mcard"))) return openSheet(el.dataset.id, t.closest("[data-buy]")?.dataset.buy);
    if (q("[data-bot-toggle]")) return setBot(!botOn);
    if ((el = q("[data-chips] button"))) { ui[el.closest("[data-chips]").dataset.chips] = el.dataset.v; saveUi(); return draw(); }
    if ((el = q("[data-tf]"))) {
      const tf = Number(el.dataset.tf);
      strategy.timeframes = strategy.timeframes.includes(tf) ? strategy.timeframes.filter(x => x !== tf) : [...strategy.timeframes, tf];
      strategy = S.sanitize(strategy); S.save(strategy); return render();
    }
    if ((el = q("[data-maxopen-step]"))) { strategy.maxOpen = Math.max(1, Math.min(20, strategy.maxOpen + Number(el.dataset.maxopenStep))); S.save(strategy); pulse($("#maxOpenInput")); return render(); }
    if ((el = q("[data-seg='botMode'] button"))) { reloadBook(); account.botMode = el.dataset.v; saveAccount(); offered.clear(); return render(); }
  });

  document.addEventListener("change", e => {
    if (e.target.matches?.("[data-show-all]")) {
      const form = e.target.closest("form");
      $$("input[type=password], input[data-was-password]", form).forEach(i => { i.dataset.wasPassword = "1"; i.type = e.target.checked ? "text" : "password"; });
      $$("[data-eye]", form).forEach(b => { b.textContent = e.target.checked ? "Hide" : "Show"; });
    }
  });

  document.addEventListener("submit", async e => {
    const form = e.target;
    if (!["accountForm", "unlockForm", "revealForm"].includes(form.id)) return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const btn = form.querySelector("[type=submit]"), btnText = btn.textContent;
    form.querySelectorAll(".form-error").forEach(x => x.remove());
    btn.disabled = true; submitting = true;
    btn.textContent = form.id === "accountForm" ? "Saving…" : form.id === "unlockForm" ? "Unlocking…" : "Checking passcode…";
    let rerender = false, unlockAfter = null;
    try {
      if (form.id === "accountForm") {
        if (editPrefill?.passcode) data.oldPasscode = editPrefill.passcode;
        const meta = await L.save(data);
        panelMode = null; editPrefill = null; revealed = null; rerender = true;
        toast(`Saved "${meta.label}" on this device.`, "good");
        unlockAfter = { id: meta.id, passcode: data.passcode };
      } else if (form.id === "unlockForm") {
        await L.unlock(L.state.activeId, data.passcode);
        unlockedPasscode = data.passcode;
        toast(L.canTrade() ? "Unlocked. This account can trade." : `Unlocked read-only. ${L.state.message || ""}`, L.canTrade() ? "good" : "info");
        rerender = true;
      } else {
        revealed = { ...(await L.reveal(L.state.activeId, data.passcode)), passcode: data.passcode };
        clearTimeout(revealTimer);
        revealTimer = setTimeout(() => { revealed = null; $("#livePanel")._sig = null; render(); }, 120000);
        rerender = true;
      }
    } catch (err) {
      const box = document.createElement("p");
      box.className = "form-error"; box.textContent = err.message;
      btn.before(box);
      box.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } finally {
      submitting = false; btn.disabled = false; btn.textContent = btnText;
      if (rerender) { $("#livePanel")._sig = null; document.activeElement?.blur?.(); }
      render();
    }
    if (unlockAfter) {
      try { await L.unlock(unlockAfter.id, unlockAfter.passcode); unlockedPasscode = unlockAfter.passcode; toast(L.canTrade() ? "Connected. This account can trade." : `Connected read-only. ${L.state.message || ""}`, L.canTrade() ? "good" : "info"); }
      catch (err) { toast(err.message, "bad"); }
      $("#livePanel")._sig = null; render();
    }
  });

  $("#accountFile").addEventListener("change", async e => {
    const file = e.target.files?.[0]; e.target.value = "";
    if (!file) return;
    try { const r = await L.importFile(file); toast(`Loaded ${r.added} new and updated ${r.updated} account${r.added + r.updated === 1 ? "" : "s"}. Unlock one with its passcode.`, "good"); $("#livePanel")._sig = null; }
    catch (err) { toast(err.message, "bad"); }
    render();
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && sheet) closeSheet();
    if ((e.key === "Enter" || e.key === " ") && e.target.classList?.contains("mcard")) { e.preventDefault(); openSheet(e.target.dataset.id); }
  });
  $("#backdrop").addEventListener("click", closeSheet);
  (() => {
    const el = $("#sheet"); let y0 = null, dy = 0;
    el.addEventListener("touchstart", e => { if (el.scrollTop <= 0) { y0 = e.touches[0].clientY; dy = 0; } }, { passive: true });
    el.addEventListener("touchmove", e => { if (y0 == null) return; dy = e.touches[0].clientY - y0; if (dy > 0) el.style.transform = `translateY(${dy}px)`; }, { passive: true });
    el.addEventListener("touchend", () => { if (y0 == null) return; el.style.transform = ""; if (dy > 90) closeSheet(); y0 = null; });
  })();

  $$('[data-money="risk"] input[data-m]').forEach(inp => {
    inp.addEventListener("input", () => {
      const val = parseFloat(inp.value.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(val)) return;
      S.setMoney(strategy.risk, inp.dataset.m, val, equity());
      S.save(strategy); drawMoney(); updateSheet();
    });
    inp.addEventListener("blur", () => { S.save(strategy); render(); });
    inp.addEventListener("focus", () => inp.select());
  });

  $("#maxOpenInput").addEventListener("input", e => { const v = parseInt(e.target.value.replace(/\D/g, ""), 10); if (v >= 1) { strategy.maxOpen = Math.min(20, v); S.save(strategy); render(); } });
  $("#maxOpenInput").addEventListener("blur", e => { e.target.value = String(strategy.maxOpen); });
  $("#maxOpenInput").addEventListener("focus", e => e.target.select());
  $("#refreshSelect").addEventListener("change", e => { reloadBook(); account.refreshSec = Number(e.target.value); saveAccount(); D.setDiscoveryInterval(account.refreshSec); toast("Market refresh interval updated.", "info"); });
  const balanceInput = () => { const v = parseFloat($("#startInput").value.replace(/[^0-9.]/g, "")); if (!(v >= 10)) { toast("Enter a paper balance of at least $10.", "bad"); return null; } return Math.round(v * 100) / 100; };
  $("#setBalance").addEventListener("click", () => {
    const v = balanceInput(); if (v == null) return;
    reloadBook();
    account.cash = v;
    const eq = paperEquity();
    Object.assign(account, { startBalance: eq, dayKey: todayKey(), dayStart: eq });
    saveAccount(); toast(`Paper cash set to ${money(v)}.`, "good"); render();
  });
  $("#resetAccount").addEventListener("click", () => {
    const v = balanceInput(); if (v == null) return;
    if (!confirm(`Reset the paper account to ${money(v)}? This clears paper trade history.`)) return;
    reloadBook();
    Object.assign(account, { startBalance: v, cash: v, dayKey: todayKey(), dayStart: v });
    trades = []; saveAccount(); saveTrades(); watchOpen();
    $("#history")._sig = null;
    toast(`Paper account reset to ${money(v)}.`, "good"); render();
  });
  $("#resetAll").addEventListener("click", async () => {
    if (!confirm("Erase all BlueEdge data on this device, including any connected live account?")) return;
    await L.lock();
    Object.keys(localStorage).filter(k => k.startsWith("blueedge.")).forEach(k => localStorage.removeItem(k));
    location.hash = ""; location.reload();
  });
  $("#exportBtn").addEventListener("click", () => {
    const rows = [["opened", "closed", "asset", "timeframe", "side", "shares", "entry", "exit", "fees", "pnl", "status", "market"]];
    trades.forEach(t => rows.push([new Date(t.openedAt).toISOString(), t.closedAt ? new Date(t.closedAt).toISOString() : "", t.asset, tfShort(t.tf), t.side, t.shares.toFixed(2), t.entry, t.exit ?? "", ((t.fee || 0) + (t.exitFee || 0)).toFixed(4), t.pnl != null ? t.pnl.toFixed(4) : "", t.status, t.url]));
    const blob = new Blob([rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `blueedge-paper-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $("#cancelAllBtn").addEventListener("click", async () => {
    if (!confirm(`Cancel all ${L.state.orders.length} open orders?`)) return;
    try { await L.cancelAll(); toast("All open orders cancelled.", "good"); } catch (err) { toast(err.message, "bad"); }
  });

  window.addEventListener("storage", e => {
    if (![K.account, K.trades, K.bot, K.mode, S.KEY].includes(e.key)) return;
    reloadBook();
    botOn = read(K.bot, false) === true;
    mode = read(K.mode, "paper") === "live" ? "live" : "paper";
    if (e.key === S.KEY) strategy = S.load();
    if (e.key === K.trades) $("#history")._sig = null;
    watchOpen(); render();
  });
  window.addEventListener("hashchange", route);
  window.addEventListener("resize", () => { if (view === "trades" && !isLive()) drawEquityChart(); });

  D.on("markets", render); D.on("books", render); D.on("spot", render); D.on("status", render);
  D.on("resolved", () => setTimeout(settlePaper, 3000));
  D.on("resolution", () => { render(); settlePaper(); });
  // keep the app full screen: block pinch-zoom outside the chart (the chart has its own pinch)
  ["gesturestart", "gesturechange"].forEach(ev => document.addEventListener(ev, e => { if (!e.target.closest?.(".chart-host")) e.preventDefault(); }, { passive: false }));
  document.addEventListener("touchmove", e => { if (e.touches.length > 1 && !e.target.closest?.(".chart-host")) e.preventDefault(); }, { passive: false });
  L.on(render);
  C.onUpdate(() => applyChartLine());

  /* ---------- Add to Home Screen ---------- */
  (function initInstallBanner() {
    const banner = $("#installBanner"), text = $("#installBannerText"), goBtn = $("#installBannerGo"), closeBtn = $("#installBannerClose");
    if (!banner) return;
    const DISMISS_KEY = "blueedge.installDismissedAt";
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    if (isStandalone) return;
    const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) || 0);
    if (Date.now() - dismissedAt < 14 * 24 * 3600000) return; // don't nag more than once every 2 weeks
    let hideTimer = null;
    const hide = () => { banner.hidden = true; clearTimeout(hideTimer); };
    const show = msg => { text.textContent = msg; banner.hidden = false; clearTimeout(hideTimer); hideTimer = setTimeout(hide, 10000); };
    closeBtn.addEventListener("click", () => { localStorage.setItem(DISMISS_KEY, String(Date.now())); hide(); });

    let deferredPrompt = null;
    window.addEventListener("beforeinstallprompt", e => {
      e.preventDefault(); deferredPrompt = e; goBtn.style.display = "";
      show("Install BlueEdge as an app on this device.");
    });
    goBtn.addEventListener("click", async () => {
      if (!deferredPrompt) return hide();
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      deferredPrompt = null; hide();
      if (outcome === "accepted") localStorage.setItem(DISMISS_KEY, String(Date.now()));
    });

    const ua = navigator.userAgent;
    const isIOS = /iphone|ipad|ipod/i.test(ua) && !window.MSStream;
    const isSafari = isIOS && /safari/i.test(ua) && !/crios|fxios|opios/i.test(ua);
    if (isIOS && isSafari) { goBtn.style.display = "none"; show('Tap Share, then "Add to Home Screen" to install BlueEdge.'); }

    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  })();


  /* ---------- start ---------- */
  if (mode === "live" && !L.hasVault()) { mode = "paper"; write(K.mode, mode); }
  setInterval(() => { if (view === "settings") drawSettings(); }, 5000);
  if (botOn && mode === "live") { botOn = false; write(K.bot, false); } // the live bot never resumes on its own after a reload
  watchOpen();
  D.startLoop({ intervalSec: account.refreshSec, keepAliveHidden: () => botOn || openTrades().length > 0 });
  setInterval(render, 1000);
  setInterval(tick, 2000);
  route();
})();
