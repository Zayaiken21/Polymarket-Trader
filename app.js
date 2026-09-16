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
  const ui = { homeTf: "all", marketsTf: "all", marketsWhen: "live", chartCoin: "BTC", chartInterval: "15m", chartMarket: null, ...read(K.ui, {}) };
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
  const fmtPrice = p => p == null ? "—" : p >= 1000 ? "$" + p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : p >= 1 ? "$" + p.toFixed(p >= 100 ? 2 : 4) : "$" + p.toFixed(5);
  const set = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
  const html = (el, h) => { if (el && el._html !== h) { el.innerHTML = h; el._html = h; } };
  const signClass = n => (n > 0.004 ? "gain" : n < -0.004 ? "loss" : "");
  const shortAddr = a => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—";
  const ago = ms => { const s = Math.round((Date.now() - ms) / 1000); return s < 5 ? "just now" : s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`; };
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
    const ctx = { now, up: { bid: ub.bid ?? null, ask: ub.ask ?? null }, down: { bid: db.bid ?? null, ask: db.ask ?? null }, open: D.openFor(m), spot: D.spotFor(m.asset) };
    const um = mid(ctx.up), dm = mid(ctx.down);
    return {
      m, ctx, decision: S.evaluate(strategy, m, ctx),
      upProb: um != null ? um : dm != null ? 1 - dm : null,
      move: ctx.open != null && ctx.spot != null ? (ctx.spot - ctx.open) / ctx.open : null,
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
  function updateCard(el, v) {
    const now = Date.now();
    set(field(el, "left"), v.live ? clock(v.left) : v.m.start > now ? `in ${clock(v.m.start - now)}` : "settling");
    field(el, "progress").style.transform = `scaleX(${v.progress.toFixed(4)})`;
    set(field(el, "upAsk"), cents(v.ctx.up.ask));
    set(field(el, "downAsk"), cents(v.ctx.down.ask));
    field(el, "split").style.transform = `scaleX(${(v.upProb ?? 0.5).toFixed(4)})`;
    set(field(el, "spot"), v.ctx.spot != null ? `Binance ${fmtPrice(v.ctx.spot)}` : "Binance connecting…");
    const mv = field(el, "move");
    set(mv, v.move == null ? "" : `${v.move >= 0 ? "▲" : "▼"} ${(Math.abs(v.move) * 100).toFixed(3)}%`);
    mv.className = v.move == null ? "" : v.move >= 0 ? "gain" : "loss";
    const held = holdingFor(v.m);
    const st = field(el, "status");
    set(st, held ? `You hold ${held.side}` : v.decision.reason);
    st.className = "mc-status " + (held ? "held" : v.decision.ok ? "ready" : /are off/.test(v.decision.reason) ? "off" : "wait");
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
        <div><dt>Binance now</dt><dd data-f="spot"></dd></div><div><dt>Window open</dt><dd data-f="open"></dd></div>
        <div><dt>Move</dt><dd data-f="move"></dd></div><div><dt>Liquidity</dt><dd data-f="liq"></dd></div>
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
    set(f("leftLabel"), v.live ? "left in this window" : m.start > now ? "until this window opens" : "closed, waiting for result");
    f("progress").style.transform = `scaleX(${v.progress.toFixed(4)})`;
    set(f("upAsk"), cents(v.ctx.up.ask)); set(f("downAsk"), cents(v.ctx.down.ask));
    set(f("upBid"), `sell ${cents(v.ctx.up.bid)}`); set(f("downBid"), `sell ${cents(v.ctx.down.bid)}`);
    $$(".side", el).forEach(b => b.setAttribute("aria-checked", String(b.dataset.side === side)));
    set(f("spot"), fmtPrice(v.ctx.spot)); set(f("open"), fmtPrice(v.ctx.open));
    const mv = f("move"); set(mv, v.move == null ? "—" : `${v.move >= 0 ? "+" : "−"}${(Math.abs(v.move) * 100).toFixed(3)}%`); mv.className = v.move == null ? "" : v.move >= 0 ? "gain" : "loss";
    set(f("liq"), m.liquidity ? "$" + Math.round(m.liquidity).toLocaleString() : "—");

    const live = isLive();
    const cash = live ? (L.state.balance ?? 0) : account.cash;
    const stake = Math.min(S.stake(strategy, equity()), cash);
    const ask = book.ask;
    const shares = ask > 0 && ask < 1 ? Math.floor((stake / ask) * 100) / 100 : 0;
    set(f("acct"), live ? (L.isUnlocked() ? "Live (real money)" : "Live, locked") : "Paper");
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
    trades.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), marketId: m.id, slug: m.slug, url: m.url, asset: m.asset, tf: m.tf, start: m.start, end: m.end, side, outcome: side === "Up" ? m.upLabel : m.downLabel, token, feeRate: m.feeRate, entry: ask, shares, cost, fee, openedAt: Date.now(), status: "open", source });
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
  let settling = false, lastSettle = 0;
  async function settlePaper(force = false) {
    if (settling || !isLeader()) return;
    const due = openTrades().filter(t => Date.now() > t.end + 15000);
    if (!due.length || (!force && Date.now() - lastSettle < 15000)) return;
    settling = true; lastSettle = Date.now();
    try {
      const results = await D.fetchResolutions(due.map(t => t.slug));
      reloadBook();
      let changed = 0;
      for (const t of trades) {
        if (t.status !== "open") continue;
        const r = results[t.slug];
        if (!r || !r.winner) continue;
        const won = r.winner.toLowerCase() === String(t.outcome || t.side).toLowerCase();
        const payout = won ? t.shares : 0;
        Object.assign(t, { status: won ? "won" : "lost", exit: won ? 1 : 0, closedAt: Date.now(), pnl: payout - t.cost - t.fee, note: `Settled ${r.winner}` });
        account.cash += payout; changed++;
        toast(`${t.asset} ${tfShort(t.tf)} settled ${r.winner}. Paper ${won ? "win" : "loss"} of ${money(Math.abs(t.pnl))}.`, won ? "good" : "bad");
      }
      if (changed) { saveAccount(); saveTrades(); watchOpen(); render(); }
    } catch (e) { console.warn("Settlement check failed:", e.message); }
    finally { settling = false; }
  }

  /* ---------- live trading ---------- */
  async function liveBuy(m, side, source) {
    if (liveBusy) return { ok: false, msg: "Another order is in progress." };
    if (!L.isUnlocked()) { if (source !== "bot") toast("Unlock your live account in Settings first.", "bad"); return { ok: false, msg: "Live account is locked." }; }
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
    if (!strategy.timeframes.length) { botNote = "Turn on at least one timeframe."; return; }
    rollDay();
    const now = Date.now();
    const views = liveMarkets(now).map(m => vm(m, now));

    if (isLive()) {
      if (!L.isUnlocked()) { botNote = "Waiting: unlock your live account in Settings."; return; }
      if (liveBusy) return;
      const idx = tokenIndex();
      const activePositions = L.state.positions.filter(p => { const hit = idx.get(String(p.assetId ?? p.tokenId)); return hit && hit.m.end > now; });
      const openCount = activePositions.length + L.state.orders.length;
      if (openCount >= S.RULES.maxOpen) { botNote = `Holding ${openCount} of ${S.RULES.maxOpen} live positions/orders.`; return; }
      const tried = liveTried();
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
    if (open.length >= S.RULES.maxOpen) { botNote = `Holding ${open.length} of ${S.RULES.maxOpen} paper positions.`; return; }
    const ready = views.filter(v => v.decision.ok && !trades.some(t => t.marketId === v.m.id)).sort((a, b) => a.m.end - b.m.end);
    if (!ready.length) { botNote = views.length ? `Watching ${views.length} live markets. None match right now.` : "Waiting for live markets…"; return; }
    if (account.botMode === "ask") return offer(ready);
    let slots = S.RULES.maxOpen - open.length, bought = 0, lastMsg = "";
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
      if (!L.isUnlocked()) { toast("Unlock your live account before starting the bot.", "bad"); location.hash = "#settings"; return; }
      const stake = S.stake(strategy, L.equity());
      if (!confirm(`Start the LIVE bot?\n\nIt will place real market orders of about ${money(stake)} each on Polymarket, up to ${S.RULES.maxOpen} at a time, while this page is open.`)) return;
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
    if (mode === "live" && L.isUnlocked()) L.refresh(true);
    render();
  }
  function watchOpen() { const open = openTrades(); D.watch({ tokens: open.map(t => t.token), assets: open.map(t => t.asset) }); }

  /* ---------- rendering ---------- */
  let queued = false;
  function render() { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; draw(); }); }
  function draw() {
    rollDay();
    drawHeader(); drawAccount(); drawBot(); drawMoney();
    if (view === "home") drawHome();
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
    set($("#equity"), money(eq));
    const total = eq - account.startBalance;
    html($("#equitySub"), `<span class="${signClass(total)}">${money(total, true)}</span> since last reset`);
    const day = eq - account.dayStart;
    html($("#accountStats"), statRow([["Cash", money(account.cash)], ["Today", money(day, true), signClass(day)], ["Win rate", closed.length ? `${Math.round((wins / closed.length) * 100)}%` : "—"], ["Open", String(openTrades().length)]]));
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
    html($("#rulesList"), S.rulesText().map(r => `<li>${esc(r)}</li>`).join(""));
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

  function drawHome() {
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
    } else list = liveMarkets(now);
    list = list.filter(m => ui.marketsTf === "all" || m.tf === Number(ui.marketsTf)).map(m => vm(m, now)).sort((a, b) => (b.decision.ok - a.decision.ok) || a.m.end - b.m.end);
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
    if (C.symbol !== ui.chartCoin + "USDT" || C.interval !== ui.chartInterval) C.load(ui.chartCoin, ui.chartInterval).then(applyChartLine);
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
    set(field(el, "sub"), v.ctx.open != null ? `Open ${fmtPrice(v.ctx.open)}${v.move != null ? `, ${v.move >= 0 ? "+" : "−"}${(Math.abs(v.move) * 100).toFixed(3)}%` : ""}` : "Waiting for window open");
    set(field(el, "odds"), `Up ${cents(v.ctx.up.ask)} / Down ${cents(v.ctx.down.ask)}`);
    set(field(el, "left"), `${clock(v.left)} left`);
    el.classList.toggle("selected", ui.chartMarket === v.m.id);
  }
  function applyChartLine() {
    const m = ui.chartMarket && D.state.markets.get(ui.chartMarket);
    if (!m || m.asset !== ui.chartCoin || m.end < Date.now()) { C.clearPriceLine(); return; }
    const open = D.openFor(m);
    if (open != null) C.setPriceLine(open, `${tfShort(m.tf)} open`);
  }

  /* positions */
  function createPos(t) {
    const el = document.createElement("div");
    el.className = "pos";
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
        <div class="hrow">${coinBadge(t.asset, "sm")}
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
      ["#liveOrders", "#livePositions", "#liveFills"].forEach(s => html($(s), msg));
      set($("#lBalance"), "—"); set($("#lPosValue"), "—"); set($("#lOrderCount"), "0"); set($("#lUpdated"), "—");
      $("#cancelAllBtn").disabled = true;
      return;
    }
    const idx = tokenIndex();
    set($("#lBalance"), st.balance == null ? "—" : money(st.balance));
    set($("#lPosValue"), money(st.positions.reduce((s, p) => s + Number(p.currentValue || 0), 0)));
    set($("#lOrderCount"), String(st.orders.length));
    set($("#lUpdated"), st.lastRefresh ? ago(st.lastRefresh) : "—");
    $("#cancelAllBtn").disabled = !st.orders.length;

    html($("#liveOrders"), st.orders.length ? st.orders.map(o => {
      const d = describeToken(o.assetId ?? o.tokenId, idx);
      const filled = Number(o.sizeMatched || 0), size = Number(o.originalSize || 0);
      return `<div class="pos">${coinBadge(d?.asset || "?")}<div class="pos-main"><b>${esc(o.side)} ${esc(d?.label || o.outcome || "Order")}</b><span>${filled.toFixed(2)} of ${size.toFixed(2)} filled at ${cents(Number(o.price))}</span></div>
        <div class="pos-pnl"><b>${money(size * Number(o.price))}</b><span>${esc(o.orderType || "")} ${esc(String(o.status || "").toLowerCase())}</span></div><button class="btn small" data-cancel="${esc(o.id)}">Cancel</button></div>`;
    }).join("") : `<div class="empty"><p>No open orders. Bot orders fill immediately or cancel, so they rarely stay open.</p></div>`);

    html($("#livePositions"), st.positions.length ? st.positions.map(p => {
      const token = String(p.assetId ?? p.tokenId), d = describeToken(token, idx);
      const size = Number(p.currentSize ?? p.size ?? 0), value = Number(p.currentValue || 0), cost = Number(p.totalCostUsdc ?? p.entryCostUsdc ?? size * Number(p.avgPrice || 0));
      const pnl = value - cost, ended = d?.m ? d.m.end <= Date.now() : false;
      return `<div class="pos">${coinBadge(d?.asset || "?")}<div class="pos-main"><b>${esc(d?.label || p.title || p.outcome || shortAddr(token))}</b><span>${size.toFixed(2)} shares, avg ${cents(Number(p.avgPrice))}, now ${cents(Number(p.currentPrice))}</span></div>
        <div class="pos-pnl"><b class="${signClass(pnl)}">${money(pnl, true)}</b><span>${money(value)}</span></div>
        ${d && !ended ? `<button class="btn small" data-live-sell="${esc(token)}">Sell</button>` : `<span class="tag">${ended ? "Settling" : "Held"}</span>`}</div>`;
    }).join("") : `<div class="empty"><p>No open positions. Polymarket redeems winning positions to your cash automatically.</p></div>`);

    html($("#liveFills"), st.trades.length ? st.trades.slice(0, 30).map(t => {
      const d = describeToken(t.assetId ?? t.tokenId ?? t.asset_id, idx);
      const raw = t.matchTime || t.createdAt || t.timestamp;
      const ms = raw == null ? null : isNaN(raw) ? Date.parse(raw) : Number(raw) * (String(raw).length <= 10 ? 1000 : 1);
      const whenText = ms ? new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + ". " : "";
      return `<div class="hrow">${coinBadge(d?.asset || "?", "sm")}<div class="h-main"><b>${esc(t.side || "")} ${esc(d?.label || t.outcome || "Fill")}</b><span>${esc(whenText)}${Number(t.size || 0).toFixed(2)} at ${cents(Number(t.price))}</span></div>
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

  /* settings */
  let revealed = null, revealTimer = null, liveFormError = "", submitting = false;
  const secretRow = (label, value) => `<div class="secret"><span>${esc(label)}</span><code>${esc(value)}</code><button class="btn small" data-copy="${esc(value)}">Copy</button></div>`;
  function livePanelHtml() {
    const st = L.state, info = L.vaultInfo();
    const err = liveFormError ? `<p class="form-error">${esc(liveFormError)}</p>` : "";
    if (st.status === "unlocking" && !info) return `<h3>Connecting to Polymarket</h3><div class="empty small"><div class="loader"></div><p>${esc(st.message || "Connecting…")}</p></div>`;
    if (!info) return `
      <h3>Connect a Polymarket account</h3>
      <p class="hint" style="margin-top:0">Enter these once. They're encrypted with your passcode and kept on this device only.</p>
      <form id="connectForm" autocomplete="off" novalidate>
        <label class="field"><span>Account name</span><input type="text" name="label" placeholder="My Polymarket" maxlength="40"></label>
        <label class="field"><span>Polymarket wallet address</span><input type="text" name="wallet" placeholder="0x…" autocapitalize="off" spellcheck="false"><small>From your profile menu on polymarket.com. It's the address that holds your funds.</small></label>
        <label class="field"><span>Signer private key</span><input type="password" name="privateKey" placeholder="0x…" autocapitalize="off" spellcheck="false"><small>The key for the Signer Address Polymarket shows. It signs each order and creates your trading API credentials automatically.</small></label>
        <label class="field"><span>Relayer API key <em class="opt">optional</em></span><input type="password" name="relayerKey" autocapitalize="off" spellcheck="false"><small>Settings, API Keys, Relayer API Keys. Lets Polymarket set up trading approvals without gas.</small></label>
        <label class="field"><span>Relayer address <em class="opt">optional</em></span><input type="text" name="relayerAddress" placeholder="0x…" autocapitalize="off" spellcheck="false"></label>
        <label class="field"><span>Passcode</span><input type="password" name="passcode" autocomplete="new-password"><small>At least 8 characters. You'll use it to unlock this account.</small></label>
        <label class="field"><span>Confirm passcode</span><input type="password" name="passcode2" autocomplete="new-password"></label>
        ${err}
        <button class="btn primary big" type="submit">Connect account</button>
      </form>
      <button class="btn ghost" data-action="import-account">Load an account file</button>
      <p class="notice">Don't enter Builder API keys here. Polymarket says they must stay on a server, and they can't place orders anyway.</p>`;
    if (!L.isUnlocked()) return `
      <h3>${esc(info.label)}</h3>
      <dl class="kv plain"><div><dt>Wallet</dt><dd>${esc(shortAddr(info.wallet))}</dd></div><div><dt>Signer</dt><dd>${esc(shortAddr(info.signer))}</dd></div></dl>
      <form id="unlockForm" autocomplete="off" novalidate>
        <label class="field"><span>Passcode</span><input type="password" name="passcode" autocomplete="current-password"></label>
        ${err}
        <button class="btn primary big" type="submit">Unlock</button>
      </form>
      <div class="btn-row"><button class="btn ghost" data-action="export-account">Download account file</button><button class="btn ghost danger-text" data-action="disconnect">Disconnect</button></div>`;
    const acct = st.account || {};
    const cred = revealed?.credentials || {};
    const rev = revealed ? `
      <div class="secrets">
        ${secretRow("Signer private key", revealed.privateKey)}
        ${cred.key || cred.apiKey ? secretRow("CLOB API key", cred.key || cred.apiKey) + secretRow("CLOB secret", cred.secret || "") + secretRow("CLOB passphrase", cred.passphrase || "") : ""}
        ${revealed.relayerKey ? secretRow("Relayer API key", revealed.relayerKey) : ""}
        <p class="hint">Hidden again in 60 seconds.</p>
        <button class="btn ghost small" data-action="hide-secrets">Hide now</button>
      </div>` : `
      <form id="revealForm" autocomplete="off" novalidate>
        <label class="field"><span>Passcode to view keys</span><input type="password" name="passcode" autocomplete="current-password"></label>
        ${err}<button class="btn ghost" type="submit">View account details</button>
      </form>`;
    return `
      <h3>${esc(info.label)} <span class="tag won">Connected</span></h3>
      <dl class="kv plain">
        <div><dt>Cash</dt><dd>${st.balance == null ? "—" : esc(money(st.balance))}</dd></div>
        <div><dt>Wallet type</dt><dd>${esc(WALLET_TYPES[acct.walletType] ?? String(acct.walletType ?? "—"))}</dd></div>
        <div><dt>Wallet</dt><dd class="copyable" data-copy="${esc(info.wallet)}">${esc(shortAddr(info.wallet))}</dd></div>
        <div><dt>Signer</dt><dd class="copyable" data-copy="${esc(info.signer)}">${esc(shortAddr(info.signer))}</dd></div>
        <div><dt>Relayer key</dt><dd>${info.hasRelayer ? "Added" : "Not added"}</dd></div>
        <div><dt>Order updates</dt><dd>${esc({ live: "Streaming", connecting: "Connecting", reconnecting: "Reconnecting", off: "Off" }[st.stream] || st.stream)}</dd></div>
      </dl>
      ${rev}
      <div class="btn-row">
        <button class="btn ghost" data-action="export-account">Download account file</button>
        <button class="btn ghost" data-action="lock">Lock</button>
        <button class="btn ghost danger-text" data-action="disconnect">Disconnect</button>
      </div>`;
  }

  function drawSettings() {
    const panel = $("#livePanel");
    const sig = [L.state.status, L.isUnlocked(), !!revealed, L.state.balance, L.state.stream, L.state.account?.walletType, JSON.stringify(L.vaultInfo())].join("|");
    const typing = panel.contains(document.activeElement) && document.activeElement.tagName === "INPUT";
    if (panel._sig !== sig && !typing && !submitting) { panel.innerHTML = livePanelHtml(); panel._sig = sig; }
    $$("[data-seg='botMode'] button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === account.botMode)));
    const sb = $("#startInput"); if (document.activeElement !== sb && !sb.value) sb.value = String(Math.round(account.cash * 100) / 100);
    const rs = $("#refreshSelect"); if (rs.value !== String(account.refreshSec)) rs.value = String(account.refreshSec);
    const s = D.state.status, now = Date.now();
    const perMin = s.requestLog.filter(t => now - t < 60000).length;
    const label = st => ({ live: "Connected", empty: "Connected", loading: "Loading", connecting: "Connecting", reconnecting: "Reconnecting", error: "Error", idle: "Locked", offline: "Off" }[st] || st);
    const cls = st => (st === "live" || st === "empty" ? "good" : st === "error" ? "bad" : st === "offline" ? "" : "warn");
    const rows = [
      [s.gamma, "Polymarket markets", s.lastDiscovery ? `${s.gammaMsg}. Checked ${Math.round((now - s.lastDiscovery) / 1000)}s ago, ${perMin} request${perMin === 1 ? "" : "s"} in the last minute.` : s.gammaMsg || "Starting up"],
      [s.poly, "Polymarket live prices", `${s.polyTokens} outcome prices streaming.`],
      [s.binance, "Binance feed", s.binanceHost ? `Using ${s.binanceHost}. Falls back to other Binance hosts automatically.` : "Starts once markets are found."],
      [L.isUnlocked() ? (L.state.stream === "live" ? "live" : "connecting") : L.hasVault() ? "idle" : "offline", "Live account", L.isUnlocked() ? "Balance and orders update from Polymarket's user stream, with a 30 second backup refresh." : L.hasVault() ? "Connected but locked." : "Not connected."]
    ];
    html($("#connList"), rows.map(([st, name, detail]) => `<li><i class="dot ${cls(st)}"></i><div><b>${name}</b> <span class="tag-lite">${label(st)}</span><p>${esc(detail)}</p></div></li>`).join(""));
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
    draw();
  }

  /* ---------- events ---------- */
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast("Copied.", "info"); }
    catch { toast("Couldn't copy on this browser.", "bad"); }
  }

  document.addEventListener("click", async e => {
    const t = e.target, q = sel => t.closest(sel);
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
      try { await L.cancel(el.dataset.cancel); toast("Order cancelled.", "good"); } catch (err) { toast(err.message, "bad"); el.disabled = false; }
      return;
    }
    if ((el = q("[data-mode]"))) return setMode(el.dataset.mode);
    if ((el = q("[data-coin]"))) { ui.chartCoin = el.dataset.coin; ui.chartMarket = null; saveUi(); return draw(); }
    if ((el = q("[data-interval]"))) { ui.chartInterval = el.dataset.interval; saveUi(); return draw(); }
    if ((el = q("[data-open-sheet]"))) return openSheet(el.dataset.openSheet);
    if ((el = q("[data-chart-market]"))) { ui.chartMarket = ui.chartMarket === el.dataset.chartMarket ? null : el.dataset.chartMarket; saveUi(); applyChartLine(); return draw(); }

    const action = q("[data-action]")?.dataset.action;
    switch (action) {
      case "refresh":
        if (Date.now() - D.state.status.lastDiscovery < 10000) toast("Markets were refreshed a moment ago.", "info");
        else { D.discover(); toast("Checking Polymarket for markets…", "info"); }
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
        ui.chartCoin = m.asset; ui.chartMarket = m.id;
        ui.chartInterval = { 5: "1m", 15: "1m", 60: "5m" }[m.tf] || ui.chartInterval;
        saveUi(); closeSheet(); location.hash = "#chart"; return;
      }
      case "import-account": return $("#accountFile").click();
      case "export-account": try { L.exportFile(); toast("Encrypted account file saved to this device.", "good"); } catch (err) { toast(err.message, "bad"); } return;
      case "lock":
        if (botOn && isLive()) { botOn = false; write(K.bot, false); }
        revealed = null; await L.lock(); toast("Live account locked.", "info"); return render();
      case "disconnect":
        if (!confirm("Disconnect this account from this device?\n\nYour keys are removed from BlueEdge. Download the account file first if you want to load it again later.")) return;
        if (isLive()) { botOn = false; write(K.bot, false); mode = "paper"; write(K.mode, mode); }
        revealed = null; liveFormError = ""; await L.disconnect(); toast("Account disconnected. You can connect a new one now.", "info"); return render();
      case "hide-secrets": revealed = null; clearTimeout(revealTimer); return render();
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
    if ((el = q("[data-seg='botMode'] button"))) { reloadBook(); account.botMode = el.dataset.v; saveAccount(); offered.clear(); return render(); }
  });

  document.addEventListener("submit", async e => {
    const form = e.target;
    if (!["connectForm", "unlockForm", "revealForm"].includes(form.id)) return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const btn = form.querySelector("[type=submit]");
    const btnText = btn.textContent;
    btn.disabled = true;
    btn.textContent = form.id === "connectForm" ? "Connecting to Polymarket…" : form.id === "unlockForm" ? "Unlocking…" : "Checking…";
    form.querySelector(".form-error")?.remove();
    submitting = true;
    liveFormError = "";
    try {
      if (form.id === "connectForm") {
        if (data.passcode !== data.passcode2) throw new Error("The passcodes don't match.");
        await L.connect(data);
        toast("Account connected and unlocked.", "good");
      } else if (form.id === "unlockForm") {
        await L.unlock(data.passcode);
        toast("Live account unlocked.", "good");
      } else {
        revealed = await L.reveal(data.passcode);
        clearTimeout(revealTimer);
        revealTimer = setTimeout(() => { revealed = null; render(); }, 60000);
      }
      liveFormError = "";
      $("#livePanel")._sig = null;
      if (document.activeElement?.blur) document.activeElement.blur();
    } catch (err) {
      // keep what the user typed: show the error inside the current form instead of re-rendering it
      const live = document.getElementById(form.id) || form;
      let box = live.querySelector(".form-error");
      if (!box) { box = document.createElement("p"); box.className = "form-error"; live.querySelector("[type=submit]").before(box); }
      box.textContent = err.message;
      box.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } finally {
      submitting = false;
      btn.disabled = false; btn.textContent = btnText;
      render();
    }
  });

  $("#accountFile").addEventListener("change", async e => {
    const file = e.target.files?.[0]; e.target.value = "";
    if (!file) return;
    try { const info = await L.importFile(file); toast(`Loaded ${info.label}. Unlock it with its passcode.`, "good"); }
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
  D.on("resolved", () => setTimeout(() => settlePaper(true), 20000));
  L.on(render);
  C.onUpdate(() => { if (ui.chartMarket) applyChartLine(); });

  /* ---------- start ---------- */
  if (mode === "live" && !L.hasVault()) { mode = "paper"; write(K.mode, mode); }
  if (botOn && mode === "live") { botOn = false; write(K.bot, false); } // the live bot never resumes on its own after a reload
  watchOpen();
  D.startLoop({ intervalSec: account.refreshSec, keepAliveHidden: () => botOn || openTrades().length > 0 });
  setInterval(render, 1000);
  setInterval(tick, 2000);
  route();
})();
