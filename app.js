(() => {
  const D = window.BlueEdgeData, S = window.BlueEdgeStrategy;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const K = { account: "blueedge.account.v2", trades: "blueedge.trades.v2", bot: "blueedge.bot.v2", leader: "blueedge.leader.v2", ui: "blueedge.ui.v2" };
  const TAB = Math.random().toString(36).slice(2);
  const NAMES = { BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", XRP: "XRP", DOGE: "Dogecoin", BNB: "BNB", HYPE: "Hyperliquid", ADA: "Cardano", LINK: "Chainlink", LTC: "Litecoin", AVAX: "Avalanche", SUI: "Sui", TON: "Toncoin" };
  const COLORS = { BTC: "#F7931A", ETH: "#8A92F5", SOL: "#35D6B0", XRP: "#C9D4E2", DOGE: "#D6B64A", BNB: "#F0B90B", HYPE: "#7DE3CF" };
  const TITLES = { home: "Home", markets: "Markets", strategy: "Strategy", trades: "Trades", settings: "Settings" };

  /* ---------- storage ---------- */
  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v ?? d; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const todayKey = () => new Date().toDateString();

  function loadAccount() {
    let a = read(K.account, null);
    if (!a) {
      const v1 = read("blueedge.settings", {});
      const start = Number(v1.startBalance) || 10000;
      a = { name: v1.displayName || "", startBalance: start, cash: start, dayKey: todayKey(), dayStart: start };
    }
    return { name: "", startBalance: 10000, cash: 10000, dayKey: todayKey(), dayStart: 10000, refreshSec: 60, botMode: "auto", ...a };
  }
  let account = loadAccount();
  let trades = read(K.trades, []);
  let strategy = S.load();
  let botOn = read(K.bot, false) === true;
  const ui = { homeTf: "all", marketsTf: "all", marketsWhen: "live", sort: "ready", ...read(K.ui, {}) };
  let botNote = "";
  let view = "home";
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
  const signClass = n => (n > 0.004 ? "gain" : n < -0.004 ? "loss" : "");
  const shortTime = ms => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  /* ---------- account math ---------- */
  const openTrades = () => trades.filter(t => t.status === "open");
  const markOf = t => { const b = D.bookFor(t.token); return b.bid ?? t.entry; };
  const equity = () => account.cash + openTrades().reduce((s, t) => s + t.shares * markOf(t), 0);
  function rollDay() { if (account.dayKey !== todayKey()) { account.dayKey = todayKey(); account.dayStart = equity(); saveAccount(); } }
  const moneyBase = key => (key === "risk" ? equity() : account.dayStart);

  /* ---------- market view model ---------- */
  const mid = b => (b.bid != null && b.ask != null ? (b.bid + b.ask) / 2 : b.ask ?? b.bid ?? null);
  function vm(m, now = Date.now()) {
    const ub = D.bookFor(m.upToken), db = D.bookFor(m.downToken);
    const ctx = { now, up: { bid: ub.bid ?? null, ask: ub.ask ?? null }, down: { bid: db.bid ?? null, ask: db.ask ?? null }, open: D.openFor(m), spot: D.spotFor(m.asset) };
    const um = mid(ctx.up), dm = mid(ctx.down);
    return {
      m, ctx,
      decision: S.evaluate(strategy, m, ctx),
      upProb: um != null ? um : dm != null ? 1 - dm : null,
      move: ctx.open != null && ctx.spot != null ? (ctx.spot - ctx.open) / ctx.open : null,
      live: m.start <= now && m.end > now,
      left: m.end - now,
      progress: Math.min(1, Math.max(0, (now - m.start) / (m.end - m.start)))
    };
  }
  const liveMarkets = (now = Date.now()) => D.markets().filter(m => m.start <= now && m.end > now);

  /* ---------- keyed list helper (keeps DOM nodes so taps never get lost) ---------- */
  function keyed(container, items, keyOf, create, update, emptyHtml) {
    const map = container._nodes || (container._nodes = new Map());
    const keys = new Set(items.map(keyOf));
    for (const [k, el] of map) if (!keys.has(k)) { el.remove(); map.delete(k); }
    let empty = container.querySelector(":scope > .empty");
    if (!items.length) {
      if (!empty) { empty = document.createElement("div"); empty.className = "empty"; container.append(empty); }
      if (empty._html !== emptyHtml) { empty.innerHTML = emptyHtml; empty._html = emptyHtml; }
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
    const m = v.m;
    const el = document.createElement("article");
    el.className = "mcard";
    el.dataset.id = m.id;
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", `${coinName(m.asset)} ${S.tfName(m.tf)} market`);
    el.innerHTML = `
      <div class="mc-head">
        <span class="coin" style="--coin:${coinColor(m.asset)}">${esc(m.asset.slice(0, 4))}</span>
        <div class="mc-name"><b>${esc(coinName(m.asset))}</b><span>${S.tfName(m.tf)} window</span></div>
        <span class="mc-left" data-f="left"></span>
      </div>
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
    const held = trades.some(t => t.status === "open" && t.marketId === v.m.id);
    const st = field(el, "status");
    set(st, held ? "You hold a position here" : v.decision.reason);
    st.className = "mc-status " + (held ? "held" : v.decision.ok ? "ready" : /off in your strategy/.test(v.decision.reason) ? "off" : "wait");
    el.classList.toggle("is-ready", v.decision.ok && !held);
    el.classList.toggle("is-urgent", v.live && v.left < 60000);
  }

  function marketsEmpty() {
    const st = D.state.status;
    if (st.gamma === "idle" || (st.gamma === "loading" && !st.lastDiscovery)) return `<div class="loader"></div><p>Finding live crypto markets on Polymarket…</p>`;
    if (st.gamma === "error") return `<p><b>Couldn't load markets.</b> ${esc(st.gammaMsg)}</p><button class="btn small" data-action="refresh">Try again</button>`;
    return `<p><b>Nothing live on these filters.</b> New windows are picked up automatically as they open.</p>`;
  }

  /* ---------- sheet (market detail + order ticket) ---------- */
  let sheet = null; // { id, side }
  function openSheet(id, side) {
    const m = D.state.markets.get(id);
    if (!m) return;
    sheet = { id, side: side || null };
    const el = $("#sheet");
    el.innerHTML = `
      <div class="sheet-grip" aria-hidden="true"></div>
      <div class="sheet-head">
        <span class="coin" style="--coin:${coinColor(m.asset)}">${esc(m.asset.slice(0, 4))}</span>
        <div><h2 id="sheetTitle">${esc(coinName(m.asset))} ${S.tfName(m.tf)}</h2><p class="muted" data-f="window"></p></div>
        <button class="icon-btn" data-action="close-sheet" aria-label="Close">✕</button>
      </div>
      <div class="sheet-clock"><b data-f="left"></b><span data-f="leftLabel"></span></div>
      <div class="mc-progress big"><i data-f="progress"></i></div>

      <div class="sides" role="radiogroup" aria-label="Side">
        <button class="side up" role="radio" data-side="Up"><span>Up</span><b data-f="upAsk"></b><small data-f="upBid"></small></button>
        <button class="side down" role="radio" data-side="Down"><span>Down</span><b data-f="downAsk"></b><small data-f="downBid"></small></button>
      </div>

      <dl class="kv">
        <div><dt>Binance now</dt><dd data-f="spot"></dd></div>
        <div><dt>Window open</dt><dd data-f="open"></dd></div>
        <div><dt>Move</dt><dd data-f="move"></dd></div>
        <div><dt>Liquidity</dt><dd data-f="liq"></dd></div>
      </dl>

      <div class="ticket">
        <div class="ticket-row"><span>Stake</span><b data-f="stake"></b></div>
        <div class="ticket-row"><span>Shares</span><b data-f="shares"></b></div>
        <div class="ticket-row"><span>Est. fee</span><b data-f="fee"></b></div>
        <div class="ticket-row strong"><span data-f="payLabel"></span><b data-f="payout"></b></div>
      </div>

      <div class="holding" data-f="holding" hidden></div>
      <ul class="checks" data-f="checks"></ul>

      <div class="sheet-actions">
        <button class="btn primary big" data-action="sheet-buy" data-f="buyBtn"></button>
        <a class="btn ghost" href="${esc(m.url)}" target="_blank" rel="noopener">Open on Polymarket</a>
      </div>
      <p class="hint center">Paper trade at the live Polymarket ask. No real money moves.</p>`;
    $("#sheet").classList.add("open");
    $("#backdrop").classList.add("open");
    document.body.classList.add("sheet-open");
    updateSheet();
    setTimeout(() => el.querySelector("[data-action='close-sheet']")?.focus({ preventScroll: true }), 50);
  }
  function closeSheet() {
    sheet = null;
    $("#sheet").classList.remove("open");
    $("#backdrop").classList.remove("open");
    document.body.classList.remove("sheet-open");
  }
  function updateSheet() {
    if (!sheet) return;
    const m = D.state.markets.get(sheet.id);
    if (!m) return closeSheet();
    const el = $("#sheet"), v = vm(m), now = Date.now();
    const side = sheet.side || v.decision.side || "Up";
    const book = side === "Up" ? v.ctx.up : v.ctx.down;
    const f = n => field(el, n);

    set(f("window"), `${new Date(m.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} – ${new Date(m.end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
    set(f("left"), v.live ? clock(v.left) : m.start > now ? clock(m.start - now) : "0:00");
    set(f("leftLabel"), v.live ? "left in this window" : m.start > now ? "until this window opens" : "window closed, waiting for result");
    f("progress").style.transform = `scaleX(${v.progress.toFixed(4)})`;
    set(f("upAsk"), cents(v.ctx.up.ask)); set(f("downAsk"), cents(v.ctx.down.ask));
    set(f("upBid"), `sell ${cents(v.ctx.up.bid)}`); set(f("downBid"), `sell ${cents(v.ctx.down.bid)}`);
    $$(".side", el).forEach(b => b.setAttribute("aria-checked", String(b.dataset.side === side)));
    set(f("spot"), fmtPrice(v.ctx.spot));
    set(f("open"), fmtPrice(v.ctx.open));
    const mv = f("move");
    set(mv, v.move == null ? "—" : `${v.move >= 0 ? "+" : "−"}${(Math.abs(v.move) * 100).toFixed(3)}%`);
    mv.className = v.move == null ? "" : v.move >= 0 ? "gain" : "loss";
    set(f("liq"), m.liquidity ? "$" + Math.round(m.liquidity).toLocaleString() : "—");

    const eq = equity();
    const stake = Math.min(S.stake(strategy, eq), account.cash);
    const ask = book.ask;
    const shares = ask > 0 && ask < 1 ? Math.floor((stake / ask) * 100) / 100 : 0;
    set(f("stake"), money(stake));
    set(f("shares"), shares ? shares.toFixed(2) : "—");
    set(f("fee"), shares ? money(S.fee(shares, ask, m.feeRate)) : "—");
    set(f("payLabel"), `Pays if ${side} wins`);
    set(f("payout"), shares ? money(shares) : "—");

    const held = trades.find(t => t.status === "open" && t.marketId === m.id);
    const h = f("holding");
    h.hidden = !held;
    if (held) {
      const mark = markOf(held), pnl = held.shares * mark - held.cost - held.fee;
      const html = `<div><b>You hold ${held.shares.toFixed(2)} ${esc(held.side)}</b><span>Bought at ${cents(held.entry)}, now ${cents(D.bookFor(held.token).bid)}</span></div><span class="${signClass(pnl)}">${money(pnl, true)}</span><button class="btn small" data-sell="${held.id}">Sell</button>`;
      if (h._html !== html) { h.innerHTML = html; h._html = html; }
    }

    const checks = v.decision.checks.length
      ? v.decision.checks.map(c => `<li class="${c.pass ? "ok" : "no"}">${esc(c.pass ? c.label : c.why)}</li>`).join("")
      : `<li class="no">${esc(v.decision.reason)}</li>`;
    const ch = f("checks");
    const checksHtml = `<li class="checks-title">Your strategy on this market</li>${checks}`;
    if (ch._html !== checksHtml) { ch.innerHTML = checksHtml; ch._html = checksHtml; }

    const btn = f("buyBtn");
    const blocked = !v.live && m.start <= now ? "Window closed" : held ? "Already holding" : !(ask > 0 && ask < 1) ? `No ${side} sellers` : shares < m.minShares ? `Min ${m.minShares} shares` : "";
    set(btn, blocked || `Buy ${side} for ${money(shares * ask)}`);
    btn.disabled = !!blocked;
    btn.classList.toggle("down", side === "Down");
  }

  /* ---------- trading ---------- */
  function buy(m, side, source = "manual") {
    const fail = msg => { if (source !== "bot") toast(msg, "bad"); return { ok: false, msg }; };
    reloadBook(); rollDay();
    const now = Date.now();
    if (m.end <= now) return fail("This window has closed.");
    if (trades.some(t => t.status === "open" && t.marketId === m.id)) return fail("You already hold this market.");
    const token = side === "Up" ? m.upToken : m.downToken;
    const ask = D.bookFor(token).ask;
    if (!(ask > 0 && ask < 1)) return fail(`No ${side} sellers right now.`);
    const stake = Math.min(S.stake(strategy, equity()), account.cash);
    const shares = Math.floor((stake / ask) * 100) / 100;
    if (shares < m.minShares) return fail(`Stake is too small. Polymarket's minimum is ${m.minShares} shares (${money(m.minShares * ask)}).`);
    const cost = shares * ask, fee = S.fee(shares, ask, m.feeRate);
    if (cost + fee > account.cash + 1e-9) return fail("Not enough paper cash.");
    account.cash -= cost + fee;
    const trade = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      marketId: m.id, slug: m.slug, url: m.url, asset: m.asset, tf: m.tf, start: m.start, end: m.end,
      side, outcome: side === "Up" ? m.upLabel : m.downLabel, token, feeRate: m.feeRate,
      entry: ask, shares, cost, fee, openedAt: now, status: "open", source
    };
    trades.push(trade);
    saveAccount(); saveTrades(); watchOpen();
    toast(`${source === "bot" ? "Bot bought" : "Bought"} ${shares.toFixed(2)} ${side} on ${m.asset} ${tfShort(m.tf)} at ${cents(ask)}`, "good");
    render();
    return { ok: true, trade };
  }

  function sell(id, why = "Sold") {
    reloadBook();
    const t = trades.find(x => x.id === id && x.status === "open");
    if (!t) return false;
    const bid = D.bookFor(t.token).bid;
    if (!(bid > 0)) { toast("No buyers for this position right now. It will settle when the window closes.", "bad"); return false; }
    const fee = S.fee(t.shares, bid, t.feeRate);
    const proceeds = t.shares * bid - fee;
    Object.assign(t, { status: "sold", exit: bid, exitFee: fee, closedAt: Date.now(), pnl: proceeds - t.cost - t.fee, note: why });
    account.cash += proceeds;
    saveAccount(); saveTrades(); watchOpen();
    toast(`${why}: ${t.asset} ${tfShort(t.tf)} ${t.side} at ${cents(bid)} (${money(t.pnl, true)})`, t.pnl >= 0 ? "good" : "bad");
    render();
    return true;
  }

  function manageExits() {
    if (strategy.exit !== "tpsl") return;
    const now = Date.now();
    for (const t of openTrades()) {
      if (t.end <= now) continue;
      const bid = D.bookFor(t.token).bid;
      if (!(bid > 0)) continue;
      if (bid >= strategy.takeProfit) sell(t.id, "Take profit");
      else if (bid <= strategy.stopLoss) sell(t.id, "Stop loss");
    }
  }

  let settling = false, lastSettle = 0;
  async function settle(force = false) {
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
        account.cash += payout;
        changed++;
        toast(`${t.asset} ${tfShort(t.tf)} settled ${r.winner}. ${won ? "You won" : "You lost"} ${money(Math.abs(t.pnl))}.`, won ? "good" : "bad");
      }
      if (changed) { saveAccount(); saveTrades(); watchOpen(); render(); }
    } catch (e) {
      console.warn("Settlement check failed:", e.message);
    } finally { settling = false; }
  }

  /* ---------- bot ---------- */
  function isLeader() {
    const now = Date.now(), l = read(K.leader, null);
    if (!l || l.tab === TAB || now - l.ts > 7000) { write(K.leader, { tab: TAB, ts: now }); return true; }
    return false;
  }
  const leaderElsewhere = () => { const l = read(K.leader, null); return !!l && l.tab !== TAB && Date.now() - l.ts <= 7000; };
  window.addEventListener("pagehide", () => { const l = read(K.leader, null); if (l && l.tab === TAB) localStorage.removeItem(K.leader); });

  function tick() {
    const leader = isLeader();
    if (!leader) return;
    manageExits();
    settle();
    if (!botOn) { botNote = ""; return; }
    rollDay();
    const eq = equity();
    const limit = S.dailyLimit(strategy, account.dayStart);
    if (limit > 0 && account.dayStart - eq >= limit) { botNote = `Paused: today's loss limit of ${money(limit)} was reached. It resumes tomorrow.`; return; }
    if (!strategy.timeframes.length) { botNote = "No timeframes are switched on in your strategy."; return; }
    const now = Date.now();
    const views = liveMarkets(now).map(m => vm(m, now));
    const open = openTrades();
    if (open.length >= strategy.maxOpen) { botNote = `Holding ${open.length} of ${strategy.maxOpen} positions. New entries wait for one to close.`; return; }
    const ready = views.filter(v => v.decision.ok && !trades.some(t => t.marketId === v.m.id)).sort((a, b) => a.m.end - b.m.end);
    if (!ready.length) { botNote = views.length ? `Watching ${views.length} live markets. None match your filters right now.` : "Waiting for live markets…"; return; }

    if (account.botMode === "ask") {
      for (const v of ready) {
        if (offered.has(v.m.id)) continue;
        offered.add(v.m.id);
        toast(`${v.m.asset} ${tfShort(v.m.tf)}: ${v.decision.reason}`, "info", { label: "Review", fn: () => openSheet(v.m.id, v.decision.side) });
      }
      botNote = `${ready.length} market${ready.length > 1 ? "s match" : " matches"}. Waiting for your review.`;
      return;
    }
    let slots = strategy.maxOpen - open.length, bought = 0, lastMsg = "";
    for (const v of ready) {
      if (slots <= 0) break;
      const r = buy(v.m, v.decision.side, "bot");
      if (r.ok) { slots--; bought++; } else lastMsg = `Skipped ${v.m.asset} ${tfShort(v.m.tf)}: ${r.msg}`;
    }
    botNote = bought ? `Opened ${bought} new position${bought > 1 ? "s" : ""}.` : lastMsg;
  }

  function setBot(on) {
    botOn = on;
    write(K.bot, on);
    if (on) { isLeader(); toast(account.botMode === "ask" ? "Bot is on. It will ask before each trade." : "Bot is on and trading your strategy with paper money.", "info"); }
    tick(); render();
  }

  function watchOpen() {
    const open = openTrades();
    D.watch({ tokens: open.map(t => t.token), assets: open.map(t => t.asset) });
  }

  /* ---------- rendering ---------- */
  let queued = false;
  function render() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; draw(); });
  }

  function draw() {
    rollDay();
    drawHeader();
    drawAccount();
    drawBot();
    drawMoney();
    if (view === "home") drawHome();
    if (view === "markets") drawMarkets();
    if (view === "strategy") drawStrategy();
    if (view === "trades") drawTrades();
    if (view === "settings") drawSettings();
    updateSheet();
  }

  function overallStatus() {
    const s = D.state.status;
    const parts = [s.gamma === "live" || s.gamma === "empty", s.poly === "live", s.binance === "live"];
    const ok = parts.filter(Boolean).length;
    if (s.gamma === "error") return ["bad", "Offline"];
    if (ok === 3) return ["good", "Live"];
    if (ok === 0) return ["warn", "Connecting"];
    return ["warn", "Partial"];
  }

  function drawHeader() {
    const [cls, text] = overallStatus();
    $("#connDot").className = `dot ${cls}`;
    set($("#connText"), text);
    const s = D.state.status;
    const dot = st => (st === "live" ? "good" : st === "empty" ? "good" : st === "error" ? "bad" : "warn");
    $$("[data-dot]").forEach(d => { d.className = `dot ${dot(s[d.dataset.dot])}`; });
    $$("[data-bot-toggle]").forEach(b => {
      b.setAttribute("aria-pressed", String(botOn));
      const l = b.querySelector(".lbl");
      if (l) set(l, botOn ? "Bot on" : "Bot off");
    });
  }

  function drawAccount() {
    const eq = equity();
    const closed = trades.filter(t => t.status !== "open");
    const wins = closed.filter(t => t.pnl > 0).length;
    set($("#equity"), money(eq));
    const total = eq - account.startBalance;
    const tp = $("#totalPnl"); set(tp, money(total, true)); tp.className = signClass(total);
    set($("#cash"), money(account.cash));
    const day = eq - account.dayStart;
    const dp = $("#dayPnl"); set(dp, money(day, true)); dp.className = signClass(day);
    set($("#winRate"), closed.length ? `${Math.round((wins / closed.length) * 100)}%` : "—");
    set($("#openCount"), String(openTrades().length));
  }

  function drawBot() {
    set($("#botTitle"), botOn ? (account.botMode === "ask" ? "Bot is on, asking first" : "Bot is trading") : "Paper bot is off");
    let note;
    if (!botOn) note = "Turn it on to trade your strategy with paper money. It runs while this page is open.";
    else if (leaderElsewhere()) note = "Running in another open BlueEdge tab.";
    else note = botNote || "Watching for entries…";
    set($("#botNote"), note);
    $(".panel.bot").classList.toggle("on", botOn);
  }

  function drawMoney() {
    for (const key of ["risk", "daily"]) {
      const base = moneyBase(key);
      const obj = S.sync(strategy[key], base);
      $$(`[data-money="${key}"]`).forEach(box => {
        $$("input[data-m]", box).forEach(inp => {
          const fieldName = inp.dataset.m;
          inp.closest(".money-field").classList.toggle("anchor", obj.mode === fieldName);
          if (document.activeElement === inp) return;
          const val = fieldName === "pct" ? String(+obj.pct.toFixed(2)) : obj.usd.toFixed(2);
          if (inp.value !== val) inp.value = val;
        });
      });
      const hint = key === "risk"
        ? obj.mode === "pct" ? `Locked to ${+obj.pct.toFixed(2)}% of equity, so the dollar amount follows your balance.` : `Locked to ${money(obj.usd)} per trade. That's ${+obj.pct.toFixed(2)}% of equity right now.`
        : obj.mode === "pct" ? `Locked to ${+obj.pct.toFixed(2)}% of today's starting equity (${money(base)}).` : `Locked to ${money(obj.usd)}, ${+obj.pct.toFixed(2)}% of today's starting equity.`;
      $$(`[data-hint="${key}"]`).forEach(h => set(h, hint));
    }
  }

  function syncChips() {
    $$("[data-chips]").forEach(g => {
      const val = String(ui[g.dataset.chips]);
      $$("button", g).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === val)));
    });
  }

  function drawHome() {
    syncChips();
    const now = Date.now();
    let list = liveMarkets(now).filter(m => ui.homeTf === "all" || m.tf === Number(ui.homeTf)).map(m => vm(m, now));
    list.sort((a, b) => (b.decision.ok - a.decision.ok) || a.m.end - b.m.end);
    list = list.slice(0, 6);
    keyed($("#homeMarkets"), list, v => v.m.id, createCard, updateCard, marketsEmpty());
    const open = openTrades();
    $("#homePositionsBlock").hidden = !open.length;
    if (open.length) keyed($("#homePositions"), open, t => t.id, createPos, updatePos, "");
  }

  function drawMarkets() {
    syncChips();
    const sel = $("#sortSelect"); if (sel.value !== ui.sort) sel.value = ui.sort;
    const now = Date.now();
    let list;
    if (ui.marketsWhen === "next") {
      const next = new Map();
      for (const m of D.markets()) {
        if (m.start <= now) continue;
        const k = `${m.asset}:${m.tf}`;
        if (!next.has(k) || next.get(k).start > m.start) next.set(k, m);
      }
      list = [...next.values()];
    } else list = liveMarkets(now);
    list = list.filter(m => ui.marketsTf === "all" || m.tf === Number(ui.marketsTf)).map(m => vm(m, now));
    const by = {
      ending: (a, b) => a.m.end - b.m.end,
      liquidity: (a, b) => b.m.liquidity - a.m.liquidity,
      asset: (a, b) => a.m.asset.localeCompare(b.m.asset) || a.m.tf - b.m.tf,
      ready: (a, b) => (b.decision.ok - a.decision.ok) || a.m.end - b.m.end
    };
    list.sort(by[ui.sort] || by.ready);
    const assets = new Set(liveMarkets(now).map(m => m.asset));
    const readyCount = list.filter(v => v.decision.ok).length;
    set($("#marketsCaption"), D.state.status.lastDiscovery
      ? `${liveMarkets(now).length} live markets across ${assets.size} coin${assets.size === 1 ? "" : "s"}. ${readyCount} match your strategy right now.`
      : "Every live 5 min, 15 min and 1 hour crypto market on Polymarket, found automatically.");
    keyed($("#allMarkets"), list, v => v.m.id, createCard, updateCard, marketsEmpty());
  }

  /* positions */
  function createPos(t) {
    const el = document.createElement("div");
    el.className = "pos";
    el.innerHTML = `
      <span class="coin" style="--coin:${coinColor(t.asset)}">${esc(t.asset.slice(0, 4))}</span>
      <div class="pos-main"><b>${esc(t.asset)} ${tfShort(t.tf)} <em class="${t.side === "Up" ? "gain" : "loss"}">${esc(t.side)}</em></b><span data-f="sub"></span></div>
      <div class="pos-pnl"><b data-f="pnl"></b><span data-f="left"></span></div>
      <button class="btn small" data-sell="${t.id}">Sell</button>`;
    el.addEventListener("click", e => { if (!e.target.closest("[data-sell]") && D.state.markets.has(t.marketId)) openSheet(t.marketId, t.side); });
    return el;
  }
  function updatePos(el, t) {
    const now = Date.now();
    const bid = D.bookFor(t.token).bid;
    const pnl = t.shares * (bid ?? t.entry) - t.cost - t.fee;
    set(field(el, "sub"), `${t.shares.toFixed(2)} at ${cents(t.entry)}, now ${cents(bid)}`);
    const p = field(el, "pnl"); set(p, money(pnl, true)); p.className = signClass(pnl);
    set(field(el, "left"), t.end > now ? `${clock(t.end - now)} left` : "Settling…");
    el.querySelector("[data-sell]").disabled = t.end <= now;
  }

  function drawTrades() {
    const closed = trades.filter(t => t.status !== "open");
    const realized = closed.reduce((s, t) => s + (t.pnl || 0), 0);
    const wins = closed.filter(t => t.pnl > 0).length;
    const fees = trades.reduce((s, t) => s + (t.fee || 0) + (t.exitFee || 0), 0);
    const r = $("#tRealized"); set(r, money(realized, true)); r.className = signClass(realized);
    set($("#tWinRate"), closed.length ? `${Math.round((wins / closed.length) * 100)}%` : "—");
    set($("#tCount"), String(closed.length));
    set($("#tFees"), money(fees));
    keyed($("#openPositions"), openTrades(), t => t.id, createPos, updatePos, `<p>No open positions. Tap Up or Down on any live market to place a paper trade.</p>`);

    const sig = closed.map(t => t.id + t.status).join("|");
    const hist = $("#history");
    if (hist._sig !== sig) {
      hist._sig = sig;
      hist.innerHTML = closed.length ? closed.slice().reverse().slice(0, 200).map(t => `
        <div class="hrow">
          <span class="coin sm" style="--coin:${coinColor(t.asset)}">${esc(t.asset.slice(0, 4))}</span>
          <div class="h-main"><b>${esc(t.asset)} ${tfShort(t.tf)} ${esc(t.side)}</b><span>${new Date(t.openedAt).toLocaleDateString([], { month: "short", day: "numeric" })}, ${shortTime(t.openedAt)}. ${cents(t.entry)} → ${cents(t.exit)}</span></div>
          <span class="tag ${t.status}">${t.status === "won" ? "Won" : t.status === "lost" ? "Lost" : esc(t.note || "Sold")}</span>
          <b class="h-pnl ${signClass(t.pnl)}">${money(t.pnl, true)}</b>
        </div>`).join("") : `<div class="empty"><p>Closed trades will show up here.</p></div>`;
      drawChart();
    }
  }

  function drawChart() {
    const c = $("#equityCanvas");
    const closed = trades.filter(t => t.status !== "open" && t.closedAt).sort((a, b) => a.closedAt - b.closedAt);
    $("#chartEmpty").hidden = closed.length > 0;
    c.hidden = !closed.length;
    if (!closed.length) return;
    let eq = account.startBalance;
    const pts = [eq, ...closed.map(t => (eq += t.pnl || 0))];
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 600, h = c.clientHeight || 200;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const min = Math.min(...pts), max = Math.max(...pts), pad = 16;
    const x = i => pad + (i / Math.max(1, pts.length - 1)) * (w - pad * 2);
    const y = v => h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);
    ctx.strokeStyle = "rgba(120,160,200,.14)"; ctx.lineWidth = 1;
    const baseY = y(account.startBalance);
    ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(pad, baseY); ctx.lineTo(w - pad, baseY); ctx.stroke(); ctx.setLineDash([]);
    const up = pts[pts.length - 1] >= account.startBalance;
    const color = up ? "#2ECF8E" : "#FF6F7D";
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, up ? "rgba(46,207,142,.28)" : "rgba(255,111,125,.28)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.beginPath(); pts.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.lineTo(x(pts.length - 1), h); ctx.lineTo(x(0), h); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath(); pts.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
  }

  /* strategy form */
  function drawStrategy() {
    $$("[data-tf]").forEach(b => b.setAttribute("aria-pressed", String(strategy.timeframes.includes(Number(b.dataset.tf)))));
    $$("[data-seg]").forEach(g => {
      const key = g.dataset.seg;
      const val = key === "botMode" ? account.botMode : strategy[key];
      $$("button", g).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === val)));
    });
    $$("[data-s]").forEach(inp => {
      if (document.activeElement === inp) return;
      const k = inp.dataset.s;
      const val = inp.dataset.unit === "cents" ? String(+(strategy[k] * 100).toFixed(1)) : String(strategy[k]);
      if (inp.value !== val) inp.value = val;
    });
    $("#tpslFields").hidden = strategy.exit !== "tpsl";
    set($("#sideHint"), {
      follow: "Buys Up if Binance is above the price when the window opened, Down if it's below.",
      up: "Always buys Up.", down: "Always buys Down.",
      cheaper: "Buys whichever side costs less right now."
    }[strategy.side]);
    const items = S.summary(strategy, equity(), account.dayStart);
    const html = items.map(s => `<li>${esc(s)}</li>`).join("");
    const ul = $("#strategySummary");
    if (ul._html !== html) { ul.innerHTML = html; ul._html = html; }
  }

  let savedTimer;
  function saveStrategy() {
    S.save(strategy);
    const note = $("#savedNote");
    set(note, "Saved");
    note.classList.add("show");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => note.classList.remove("show"), 1400);
    render();
  }

  function drawSettings() {
    $$("[data-seg='botMode'] button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === account.botMode)));
    const n = $("#nameInput"); if (document.activeElement !== n && n.value !== account.name) n.value = account.name;
    const sb = $("#startInput"); if (document.activeElement !== sb && sb.value !== String(account.startBalance)) sb.value = String(account.startBalance);
    const rs = $("#refreshSelect"); if (rs.value !== String(account.refreshSec)) rs.value = String(account.refreshSec);
    const s = D.state.status;
    const now = Date.now();
    const perMin = s.requestLog.filter(t => now - t < 60000).length;
    const label = st => ({ live: "Connected", empty: "Connected", loading: "Loading", connecting: "Connecting", reconnecting: "Reconnecting", error: "Error", idle: "Starting", offline: "Offline" }[st] || st);
    const cls = st => (st === "live" || st === "empty" ? "good" : st === "error" ? "bad" : "warn");
    const rows = [
      [s.gamma, "Polymarket markets", s.lastDiscovery ? `${s.gammaMsg}. Checked ${Math.round((now - s.lastDiscovery) / 1000)}s ago, ${perMin} request${perMin === 1 ? "" : "s"} in the last minute.` : s.gammaMsg || "Starting up"],
      [s.poly, "Polymarket live prices", `${s.polyTokens} outcome prices streaming over WebSocket.`],
      [s.binance, "Binance feed", s.binanceHost ? `Using ${s.binanceHost}. Falls back to other Binance hosts automatically.` : "Starts once markets are found."]
    ];
    const html = rows.map(([st, name, detail]) => `<li><i class="dot ${cls(st)}"></i><div><b>${name}</b> <span class="tag-lite">${label(st)}</span><p>${esc(detail)}</p></div></li>`).join("");
    const list = $("#connList");
    if (list._html !== html) { list.innerHTML = html; list._html = html; }
  }

  /* ---------- toasts ---------- */
  function toast(msg, kind = "info", action) {
    const box = $("#toasts");
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    const span = document.createElement("span"); span.textContent = msg; el.append(span);
    if (action) {
      const b = document.createElement("button");
      b.textContent = action.label;
      b.onclick = () => { action.fn(); el.remove(); };
      el.append(b);
    }
    box.append(el);
    while (box.children.length > 3) box.firstElementChild.remove();
    const life = action ? 9000 : 3800;
    setTimeout(() => el.classList.add("out"), life);
    setTimeout(() => el.remove(), life + 350);
  }

  /* ---------- routing ---------- */
  function route() {
    const v = location.hash.slice(1);
    view = TITLES[v] ? v : "home";
    $$("[data-view]").forEach(s => { s.hidden = s.dataset.view !== view; });
    $$(".nav a").forEach(a => (a.getAttribute("href") === "#" + view ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    set($("#pageTitle"), TITLES[view]);
    document.title = `${TITLES[view]} · BlueEdge`;
    closeSheet();
    window.scrollTo(0, 0);
    draw();
  }

  /* ---------- events ---------- */
  document.addEventListener("click", e => {
    const t = e.target;
    const sellBtn = t.closest("[data-sell]");
    if (sellBtn) { e.stopPropagation(); sell(sellBtn.dataset.sell); return; }
    const action = t.closest("[data-action]")?.dataset.action;
    if (action === "refresh") {
      if (Date.now() - D.state.status.lastDiscovery < 10000) toast("Markets were refreshed a moment ago.", "info");
      else { D.discover(); toast("Checking Polymarket for markets…", "info"); }
      return;
    }
    if (action === "close-sheet") return closeSheet();
    if (action === "sheet-buy" && sheet) {
      const m = D.state.markets.get(sheet.id);
      const side = sheet.side || vm(m).decision.side || "Up";
      if (m && buy(m, side, "manual").ok) closeSheet();
      return;
    }
    const sideBtn = t.closest(".sheet .side");
    if (sideBtn && sheet) { sheet.side = sideBtn.dataset.side; updateSheet(); return; }
    const card = t.closest(".mcard");
    if (card) { openSheet(card.dataset.id, t.closest("[data-buy]")?.dataset.buy); return; }
    if (t.closest("[data-bot-toggle]")) { setBot(!botOn); return; }
    const chip = t.closest("[data-chips] button");
    if (chip) { ui[chip.closest("[data-chips]").dataset.chips] = chip.dataset.v; saveUi(); draw(); return; }
    const tfBtn = t.closest("[data-tf]");
    if (tfBtn) {
      const tf = Number(tfBtn.dataset.tf);
      strategy.timeframes = strategy.timeframes.includes(tf) ? strategy.timeframes.filter(x => x !== tf) : [...strategy.timeframes, tf].sort((a, b) => a - b);
      saveStrategy(); return;
    }
    const seg = t.closest("[data-seg] button");
    if (seg) {
      const key = seg.closest("[data-seg]").dataset.seg;
      if (key === "botMode") { reloadBook(); account.botMode = seg.dataset.v; saveAccount(); offered.clear(); render(); }
      else { strategy[key] = seg.dataset.v; saveStrategy(); }
      return;
    }
    const step = t.closest("[data-step]");
    if (step) { strategy.maxOpen = Math.max(1, Math.min(50, strategy.maxOpen + Number(step.dataset.step))); saveStrategy(); return; }
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && sheet) closeSheet();
    if ((e.key === "Enter" || e.key === " ") && e.target.classList?.contains("mcard")) { e.preventDefault(); openSheet(e.target.dataset.id); }
  });
  $("#backdrop").addEventListener("click", closeSheet);

  // swipe the sheet down to close on phones
  (() => {
    const el = $("#sheet"); let y0 = null, dy = 0;
    el.addEventListener("touchstart", e => { if (el.scrollTop <= 0) { y0 = e.touches[0].clientY; dy = 0; } }, { passive: true });
    el.addEventListener("touchmove", e => { if (y0 == null) return; dy = e.touches[0].clientY - y0; if (dy > 0) el.style.transform = `translateY(${dy}px)`; }, { passive: true });
    el.addEventListener("touchend", () => { if (y0 == null) return; el.style.transform = ""; if (dy > 90) closeSheet(); y0 = null; });
  })();

  // money fields (synced % <-> $)
  $$("[data-money] input[data-m]").forEach(inp => {
    inp.addEventListener("input", () => {
      const key = inp.closest("[data-money]").dataset.money;
      const val = parseFloat(inp.value.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(val)) return;
      S.setMoney(strategy[key], inp.dataset.m, val, moneyBase(key));
      S.save(strategy);
      drawMoney(); updateSheet();
      if (view === "strategy") drawStrategy();
    });
    inp.addEventListener("blur", () => { saveStrategy(); });
    inp.addEventListener("focus", () => inp.select());
  });

  // strategy inputs
  $$("[data-s]").forEach(inp => {
    inp.addEventListener("input", () => {
      const k = inp.dataset.s;
      let val = parseFloat(inp.value.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(val)) return;
      if (inp.dataset.unit === "cents") val = val / 100;
      strategy[k] = val;
      strategy = S.sanitize(strategy);
      S.save(strategy);
      updateSheet();
    });
    inp.addEventListener("change", () => saveStrategy());
    inp.addEventListener("blur", () => { strategy = S.sanitize(strategy); drawStrategy(); });
    inp.addEventListener("focus", () => inp.select());
  });

  $("#sortSelect").addEventListener("change", e => { ui.sort = e.target.value; saveUi(); draw(); });
  $("#nameInput").addEventListener("change", e => { reloadBook(); account.name = e.target.value.trim(); saveAccount(); });
  $("#refreshSelect").addEventListener("change", e => { reloadBook(); account.refreshSec = Number(e.target.value); saveAccount(); D.setDiscoveryInterval(account.refreshSec); toast("Market refresh interval updated.", "info"); });
  $("#resetAccount").addEventListener("click", () => {
    const val = parseFloat($("#startInput").value.replace(/[^0-9.]/g, ""));
    if (!(val >= 10)) { toast("Enter a starting balance of at least $10.", "bad"); return; }
    if (!confirm(`Reset your paper account to ${money(val)}? This clears all paper trades.`)) return;
    reloadBook();
    Object.assign(account, { startBalance: val, cash: val, dayKey: todayKey(), dayStart: val });
    trades = [];
    saveAccount(); saveTrades(); watchOpen();
    $("#history")._sig = null;
    toast(`Paper account reset to ${money(val)}.`, "good");
    draw();
  });
  $("#resetAll").addEventListener("click", () => {
    if (!confirm("Erase all BlueEdge data on this device? Strategy, trades and settings will be removed.")) return;
    Object.keys(localStorage).filter(k => k.startsWith("blueedge.")).forEach(k => localStorage.removeItem(k));
    location.hash = ""; location.reload();
  });
  $("#exportBtn").addEventListener("click", () => {
    const rows = [["opened", "closed", "asset", "timeframe", "side", "shares", "entry", "exit", "fees", "pnl", "status", "market"]];
    trades.forEach(t => rows.push([new Date(t.openedAt).toISOString(), t.closedAt ? new Date(t.closedAt).toISOString() : "", t.asset, tfShort(t.tf), t.side, t.shares.toFixed(2), t.entry, t.exit ?? "", ((t.fee || 0) + (t.exitFee || 0)).toFixed(4), t.pnl != null ? t.pnl.toFixed(4) : "", t.status, t.url]));
    const blob = new Blob([rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `blueedge-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // other tabs changed something → stay in sync
  window.addEventListener("storage", e => {
    if (![K.account, K.trades, K.bot, S.KEY].includes(e.key)) return;
    reloadBook();
    botOn = read(K.bot, false) === true;
    if (e.key === S.KEY) strategy = S.load();
    if (e.key === K.trades) $("#history")._sig = null;
    watchOpen(); render();
  });

  window.addEventListener("hashchange", route);
  window.addEventListener("resize", () => { if (view === "trades") drawChart(); });

  D.on("markets", render);
  D.on("books", render);
  D.on("spot", render);
  D.on("status", render);
  D.on("resolved", () => setTimeout(() => settle(true), 20000));

  /* ---------- start ---------- */
  watchOpen();
  D.startLoop({ intervalSec: account.refreshSec, keepAliveHidden: () => botOn || openTrades().length > 0 });
  setInterval(render, 1000);
  setInterval(tick, 2000);
  route();
})();
