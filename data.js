/* BlueEdge data layer
 * Polymarket: Gamma REST for discovery (rate-limited, cached) + CLOB market WebSocket for live bid/ask.
 * Binance: public WebSocket (miniTicker + 5m/15m/1h klines) with automatic host fallback.
 * Only 5m / 15m / 1h crypto "Up or Down" markets are kept. Assets are discovered, never hardcoded.
 */
window.BlueEdgeData = (() => {
  const GAMMA = "https://gamma-api.polymarket.com";
  const CLOB_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
  const BINANCE_HOSTS = [
    "wss://data-stream.binance.vision/stream",
    "wss://stream.binance.com:9443/stream",
    "wss://stream.binance.us:9443/stream"
  ];
  const TIMEFRAMES = [5, 15, 60];
  // Only used as a fallback when the crypto tag query returns nothing. Series found live are learned and saved.
  const SEED_ASSETS = ["btc", "eth", "sol", "xrp", "doge", "bnb", "hype"];
  const NAME_TO_SYMBOL = {
    bitcoin: "BTC", btc: "BTC", ethereum: "ETH", eth: "ETH", solana: "SOL", sol: "SOL", xrp: "XRP", ripple: "XRP",
    dogecoin: "DOGE", doge: "DOGE", bnb: "BNB", hyperliquid: "HYPE", hype: "HYPE", cardano: "ADA", ada: "ADA",
    chainlink: "LINK", link: "LINK", litecoin: "LTC", ltc: "LTC", avalanche: "AVAX", avax: "AVAX", sui: "SUI", ton: "TON"
  };

  const state = {
    markets: new Map(),   // conditionId -> market
    books: {},            // tokenId -> { bid, ask, last, ts, src }
    spot: {},             // asset -> { price, ts }
    opens: {},            // "BTC:15:startMs" -> open price
    status: {
      gamma: "idle", gammaMsg: "", lastDiscovery: 0, requestLog: [],
      poly: "offline", polyTokens: 0,
      binance: "offline", binanceHost: ""
    }
  };

  /* ---------- tiny event bus with coalescing ---------- */
  const listeners = {};
  const on = (ev, fn) => (listeners[ev] ||= []).push(fn);
  const emit = (ev, payload) => (listeners[ev] || []).forEach(fn => { try { fn(payload); } catch (e) { console.error(e); } });
  const pending = {};
  const emitSoon = (ev, ms = 300) => { if (pending[ev]) return; pending[ev] = setTimeout(() => { pending[ev] = null; emit(ev); }, ms); };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const parseArr = v => { if (Array.isArray(v)) return v; try { return JSON.parse(v || "[]"); } catch { return []; } };
  const toMs = v => { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; };
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

  /* ---------- request limiter: serial queue, ≤25 req / 10s, backoff on 429/5xx ---------- */
  const limiter = { stamps: [], max: 25, windowMs: 10000, gapMs: 150, last: 0, pauseUntil: 0, strikes: 0, chain: Promise.resolve() };
  function schedule(task) {
    const run = async () => {
      for (;;) {
        const now = Date.now();
        limiter.stamps = limiter.stamps.filter(t => now - t < limiter.windowMs);
        let wait = 0;
        if (now < limiter.pauseUntil) wait = limiter.pauseUntil - now;
        else if (limiter.stamps.length >= limiter.max) wait = limiter.windowMs - (now - limiter.stamps[0]) + 25;
        else if (now - limiter.last < limiter.gapMs) wait = limiter.gapMs - (now - limiter.last);
        if (wait <= 0) break;
        await sleep(wait);
      }
      limiter.last = Date.now();
      limiter.stamps.push(limiter.last);
      state.status.requestLog.push(limiter.last);
      state.status.requestLog = state.status.requestLog.filter(t => limiter.last - t < 60000);
      return task();
    };
    const p = limiter.chain.then(run, run);
    limiter.chain = p.catch(() => {});
    return p;
  }

  const cache = new Map();
  async function gamma(path, ttlMs = 0) {
    const url = GAMMA + path;
    const hit = cache.get(url);
    if (ttlMs && hit && Date.now() - hit.t < ttlMs) return hit.v;
    return schedule(async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
        if (res.status === 429 || res.status >= 500) {
          limiter.strikes++;
          limiter.pauseUntil = Date.now() + Math.min(60000, 2000 * 2 ** limiter.strikes);
          throw new Error(`Polymarket is throttling requests (${res.status}). Backing off.`);
        }
        if (!res.ok) throw new Error(`Polymarket returned ${res.status}`);
        const v = await res.json();
        limiter.strikes = 0;
        if (cache.size > 200) cache.clear();
        cache.set(url, { t: Date.now(), v });
        return v;
      } catch (e) {
        if (e.name === "AbortError") throw new Error("Polymarket request timed out");
        if (e instanceof TypeError) throw new Error("Can't reach Polymarket (network or browser blocked the request)");
        throw e;
      } finally { clearTimeout(timer); }
    });
  }

  /* ---------- market classification ---------- */
  function clockToMin(h, m, ap) { let x = Number(h) % 12; if (/pm/i.test(ap)) x += 12; return x * 60 + Number(m || 0); }

  function timeframeOf(ev, m) {
    const rec = String(ev?.series?.[0]?.recurrence || "").toLowerCase();
    if (rec === "5m") return 5;
    if (rec === "15m") return 15;
    if (["1h", "hourly", "60m"].includes(rec)) return 60;
    const slug = String(m.slug || ev.slug || "").toLowerCase();
    const sm = slug.match(/-updown-(\d+)(m|h)-/);
    if (sm) return Number(sm[1]) * (sm[2] === "h" ? 60 : 1);
    const end = toMs(m.endDate || ev.endDate), start = toMs(m.eventStartTime || ev.startTime);
    if (end && start) {
      const d = (end - start) / 60000;
      for (const t of TIMEFRAMES) if (Math.abs(d - t) <= Math.max(1, t * 0.05)) return t;
    }
    const text = `${ev.title || m.question || ""}`;
    const range = text.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
    if (range) { let d = clockToMin(range[4], range[5], range[6]) - clockToMin(range[1], range[2], range[3]); if (d <= 0) d += 1440; return d; }
    if (/hourly|-1h-/i.test(slug + " " + (ev?.series?.[0]?.slug || ""))) return 60;
    if (/,\s*\d{1,2}(:\d{2})?\s*(AM|PM)\s*ET/i.test(text)) return 60; // "Bitcoin Up or Down - June 1, 9AM ET"
    return 0;
  }

  function assetOf(ev, m) {
    const slug = String(m.slug || ev.slug || "").toLowerCase();
    let key = slug.match(/^([a-z0-9]+)-updown-/)?.[1];
    if (!key) key = String(ev?.series?.[0]?.slug || ev.seriesSlug || "").toLowerCase().match(/^([a-z0-9]+)-up-or-down/)?.[1];
    if (!key) key = slug.match(/^([a-z0-9]+)-up-or-down/)?.[1];
    if (!key) key = String(ev.title || m.question || "").toLowerCase().match(/^([a-z0-9 ]+?)\s+up or down/)?.[1]?.replace(/\s+/g, "");
    if (!key) return null;
    return NAME_TO_SYMBOL[key] || (key.length <= 6 ? key.toUpperCase() : null);
  }

  const isUpDown = (ev, m) => /up or down|updown|up-or-down/i.test(`${ev.title} ${ev.slug} ${m.question} ${m.slug} ${ev?.series?.[0]?.slug || ""}`);

  function normalize(ev, m) {
    if (!m || !isUpDown(ev, m)) return null;
    const tf = timeframeOf(ev, m);
    if (!TIMEFRAMES.includes(tf)) return null;
    const asset = assetOf(ev, m);
    if (!asset) return null;
    const end = toMs(m.endDate || ev.endDate);
    if (!end) return null;
    let start = toMs(m.eventStartTime || ev.startTime);
    if (!start || Math.abs((end - start) / 60000 - tf) > 2) start = end - tf * 60000;
    const outcomes = parseArr(m.outcomes).map(String);
    const tokens = parseArr(m.clobTokenIds).map(String);
    if (tokens.length < 2) return null;
    let upIdx = outcomes.findIndex(o => /^(up|yes)$/i.test(o));
    if (upIdx < 0) upIdx = 0;
    const downIdx = upIdx === 0 ? 1 : 0;
    const rate = num(m.feeSchedule?.rate);
    return {
      id: String(m.conditionId || m.id),
      slug: m.slug || ev.slug,
      title: ev.title || m.question || `${asset} Up or Down`,
      asset, tf, start, end,
      upToken: tokens[upIdx], downToken: tokens[downIdx],
      upLabel: outcomes[upIdx] || "Up", downLabel: outcomes[downIdx] || "Down",
      liquidity: num(m.liquidityNum ?? m.liquidity) || 0,
      volume: num(m.volumeNum ?? m.volume) || 0,
      accepting: m.acceptingOrders !== false && m.closed !== true,
      feeRate: rate ?? 0,
      minShares: num(m.orderMinSize) || 5,
      seriesSlug: ev?.series?.[0]?.slug || ev.seriesSlug || "",
      url: `https://polymarket.com/event/${ev.slug || m.slug}`,
      snap: { bid: num(m.bestBid), ask: num(m.bestAsk), mid: num(parseArr(m.outcomePrices)[upIdx]) }
    };
  }

  function seedBook(market) {
    const { bid, ask, mid } = market.snap;
    const up = state.books[market.upToken], down = state.books[market.downToken];
    if (!up || up.src !== "ws") state.books[market.upToken] = { bid: bid ?? mid, ask: ask ?? mid, ts: Date.now(), src: "gamma" };
    if (!down || down.src !== "ws") state.books[market.downToken] = {
      bid: ask != null ? +(1 - ask).toFixed(4) : (mid != null ? 1 - mid : null),
      ask: bid != null ? +(1 - bid).toFixed(4) : (mid != null ? 1 - mid : null),
      ts: Date.now(), src: "gamma"
    };
  }

  /* ---------- discovery ---------- */
  const SERIES_KEY = "blueedge.series.v2";
  const learnedSeries = new Set((() => { try { return JSON.parse(localStorage.getItem(SERIES_KEY) || "[]"); } catch { return []; } })());
  SEED_ASSETS.forEach(a => { learnedSeries.add(`${a}-up-or-down-5m`); learnedSeries.add(`${a}-up-or-down-15m`); });
  const seriesMissAt = new Map();

  function seriesKey(slug) {
    const x = String(slug).match(/^([a-z0-9]+)-up-or-down-(5m|15m|1h|hourly)$/);
    if (!x) return null;
    const asset = NAME_TO_SYMBOL[x[1]] || x[1].toUpperCase();
    return `${asset}:${x[2] === "5m" ? 5 : x[2] === "15m" ? 15 : 60}`;
  }

  let discovering = null;
  function discover() {
    if (discovering) return discovering;
    discovering = (async () => {
      const now = Date.now();
      state.status.gamma = "loading"; emit("status");
      const range = {
        closed: "false",
        end_date_min: new Date(now - 60000).toISOString(),
        end_date_max: new Date(now + 65 * 60000).toISOString(),
        order: "endDate", ascending: "true"
      };
      const qs = o => new URLSearchParams(o).toString();
      const found = new Map();
      let lastError = null;
      const ingest = events => {
        for (const ev of Array.isArray(events) ? events : []) {
          for (const m of ev.markets || []) {
            const n = normalize(ev, m);
            if (!n || n.end < now - 60000) continue;
            found.set(n.id, n);
            if (n.seriesSlug) learnedSeries.add(n.seriesSlug);
          }
        }
      };

      // 1) One request: every crypto event ending in the next ~hour.
      try { ingest(await gamma(`/events?${qs({ ...range, tag_slug: "crypto", limit: "500" })}`, 15000)); }
      catch (e) { lastError = e; }

      // 2) Fill gaps from known recurring series (only ones not already covered, and not recently empty).
      const coveredSeries = new Set([...found.values()].map(m => m.seriesSlug).filter(Boolean));
      const coveredKeys = new Set([...found.values()].map(m => `${m.asset}:${m.tf}`));
      for (const s of learnedSeries) {
        if (coveredSeries.has(s)) continue;
        const k = seriesKey(s);
        if (k && coveredKeys.has(k)) continue;
        if (Date.now() - (seriesMissAt.get(s) || 0) < 5 * 60000) continue;
        try {
          const before = found.size;
          ingest(await gamma(`/events?${qs({ ...range, series_slug: s, limit: "25" })}`, 15000));
          if (found.size === before) seriesMissAt.set(s, Date.now());
        } catch (e) { lastError = e; break; }
      }

      try { localStorage.setItem(SERIES_KEY, JSON.stringify([...learnedSeries].slice(-150))); } catch {}

      for (const [id, m] of found) { state.markets.set(id, { ...(state.markets.get(id) || {}), ...m }); seedBook(m); }
      for (const [id, m] of state.markets) if (m.end < Date.now() - 10 * 60000) state.markets.delete(id);

      state.status.lastDiscovery = Date.now();
      if (found.size) { state.status.gamma = "live"; state.status.gammaMsg = `${found.size} markets found`; }
      else if (lastError) { state.status.gamma = "error"; state.status.gammaMsg = lastError.message; }
      else { state.status.gamma = "empty"; state.status.gammaMsg = "No 5m, 15m or 1h crypto markets are listed right now"; }

      syncPoly(); syncBinance();
      emit("markets"); emit("status");
    })().finally(() => { discovering = null; });
    return discovering;
  }

  let loopTimer = null, intervalSec = 60, keepAliveHidden = () => false;
  function startLoop(opts = {}) {
    intervalSec = Math.max(20, Number(opts.intervalSec) || 60);
    if (opts.keepAliveHidden) keepAliveHidden = opts.keepAliveHidden;
    if (loopTimer) return;
    loopTimer = setInterval(() => {
      const now = Date.now();
      const since = now - state.status.lastDiscovery;
      if (discovering) return;
      const hidden = document.hidden && !keepAliveHidden();
      if (hidden) return;
      const every = (document.hidden ? intervalSec * 2 : intervalSec) * 1000;
      // Refresh sooner when a live window just rolled over and its successor isn't loaded yet.
      const rolled = [...state.markets.values()].some(m => m.end < now && m.end > state.status.lastDiscovery - 1000 &&
        ![...state.markets.values()].some(n => n.asset === m.asset && n.tf === m.tf && n.start <= now && n.end > now));
      if (since >= every || (rolled && since >= 15000)) discover();
      syncPoly();
    }, 1000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && Date.now() - state.status.lastDiscovery > 15000) discover();
    });
    discover();
  }
  const setInterval_ = sec => { intervalSec = Math.max(20, Number(sec) || 60); };

  /* ---------- Polymarket CLOB WebSocket ---------- */
  const poly = { last: 0, ws: null, subs: new Set(), want: new Set(), extra: new Set(), retry: 0, ping: null, timer: null };

  function wantedTokens() {
    const now = Date.now(), ids = new Set();
    const list = [...state.markets.values()].filter(m => m.end > now - 60000 && m.start < now + m.tf * 60000).sort((a, b) => a.end - b.end);
    for (const m of list) { ids.add(m.upToken); ids.add(m.downToken); if (ids.size >= 400) break; }
    poly.extra.forEach(t => ids.add(t));
    return ids;
  }

  function syncPoly() {
    poly.want = wantedTokens();
    if (!poly.want.size) return;
    const ws = poly.ws;
    if (!ws || ws.readyState > 1) { if (!poly.timer) connectPoly(); return; }
    if (ws.readyState !== 1) return;
    const add = [...poly.want].filter(x => !poly.subs.has(x));
    const drop = [...poly.subs].filter(x => !poly.want.has(x));
    if (add.length) { ws.send(JSON.stringify({ assets_ids: add, operation: "subscribe", custom_feature_enabled: true })); add.forEach(x => poly.subs.add(x)); }
    if (drop.length) { ws.send(JSON.stringify({ assets_ids: drop, operation: "unsubscribe" })); drop.forEach(x => poly.subs.delete(x)); }
    state.status.polyTokens = poly.subs.size;
  }

  function connectPoly() {
    poly.timer = null;
    if (poly.ws && poly.ws.readyState <= 1) return;
    if (!poly.want.size) return;
    let ws;
    try { ws = new WebSocket(CLOB_WS); } catch { state.status.poly = "error"; emit("status"); return; }
    poly.ws = ws;
    state.status.poly = "connecting"; emit("status");
    ws.onopen = () => {
      poly.retry = 0;
      poly.subs = new Set(poly.want);
      ws.send(JSON.stringify({ assets_ids: [...poly.subs], type: "market", custom_feature_enabled: true }));
      state.status.poly = "live"; state.status.polyTokens = poly.subs.size; emit("status");
      clearInterval(poly.ping);
      poly.ping = setInterval(() => {
        if (ws.readyState !== 1) return;
        if (Date.now() - poly.last > 35000) { try { ws.close(); } catch {} return; } // silent socket: force reconnect
        ws.send("PING");
      }, 10000);
    };
    poly.last = Date.now();
    ws.onmessage = e => {
      poly.last = Date.now();
      if (typeof e.data !== "string" || e.data === "PONG") return;
      let d; try { d = JSON.parse(e.data); } catch { return; }
      (Array.isArray(d) ? d : [d]).forEach(handlePoly);
      emitSoon("books", 250);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      clearInterval(poly.ping);
      poly.subs.clear();
      state.status.poly = "reconnecting"; emit("status");
      const delay = Math.min(30000, 1000 * 2 ** poly.retry++);
      poly.timer = setTimeout(connectPoly, delay);
    };
  }

  function setBook(id, patch) {
    if (!id) return;
    const b = state.books[id] || (state.books[id] = {});
    Object.assign(b, patch, { ts: Date.now(), src: "ws" });
  }

  function handlePoly(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.event_type) {
      case "book": {
        const bids = (msg.bids || []).map(x => +x.price).filter(Number.isFinite);
        const asks = (msg.asks || []).map(x => +x.price).filter(Number.isFinite);
        setBook(msg.asset_id, { bid: bids.length ? Math.max(...bids) : null, ask: asks.length ? Math.min(...asks) : null });
        break;
      }
      case "price_change":
        (msg.price_changes || []).forEach(pc => {
          const p = {};
          if (pc.best_bid != null) p.bid = num(pc.best_bid) || null;
          if (pc.best_ask != null) p.ask = num(pc.best_ask);
          setBook(pc.asset_id, p);
        });
        break;
      case "best_bid_ask":
        setBook(msg.asset_id, { bid: num(msg.best_bid) || null, ask: num(msg.best_ask) });
        break;
      case "last_trade_price":
        setBook(msg.asset_id, { last: num(msg.price) });
        break;
      case "market_resolved":
        emit("resolved", msg);
        break;
    }
  }

  /* ---------- Binance WebSocket ---------- */
  const HOST_KEY = "blueedge.binanceHost";
  const bin = { last: 0, dog: null, ws: null, idx: Number(localStorage.getItem(HOST_KEY)) || 0, assets: new Set(), extra: new Set(), subs: new Set(), retry: 0, fails: 0, timer: null, id: 1 };
  const streamsFor = a => { const s = a.toLowerCase() + "usdt"; return [`${s}@miniTicker`, `${s}@kline_5m`, `${s}@kline_15m`, `${s}@kline_1h`]; };

  function syncBinance() {
    const assets = new Set([...state.markets.values()].map(m => m.asset));
    bin.extra.forEach(a => assets.add(a));
    bin.assets = assets;
    if (!assets.size) return;
    const ws = bin.ws;
    if (!ws || ws.readyState > 1) { if (!bin.timer) connectBinance(); return; }
    if (ws.readyState !== 1) return;
    const add = [...assets].filter(a => !bin.subs.has(a));
    if (add.length) {
      ws.send(JSON.stringify({ method: "SUBSCRIBE", params: add.flatMap(streamsFor), id: bin.id++ }));
      add.forEach(a => bin.subs.add(a));
    }
  }

  function connectBinance() {
    bin.timer = null;
    if (bin.ws && bin.ws.readyState <= 1) return;
    const assets = [...bin.assets];
    if (!assets.length) return;
    const host = BINANCE_HOSTS[bin.idx % BINANCE_HOSTS.length];
    state.status.binanceHost = new URL(host).hostname;
    state.status.binance = "connecting"; emit("status");
    let got = false, ws;
    try { ws = new WebSocket(`${host}?streams=${assets.flatMap(streamsFor).join("/")}`); }
    catch { bin.idx++; bin.timer = setTimeout(connectBinance, 1500); return; }
    bin.ws = ws;
    const probe = setTimeout(() => { if (!got) try { ws.close(); } catch {} }, 10000);
    ws.onopen = () => { bin.subs = new Set(assets); };
    bin.last = Date.now();
    clearInterval(bin.dog);
    bin.dog = setInterval(() => { if (bin.ws === ws && ws.readyState === 1 && Date.now() - bin.last > 30000) { try { ws.close(); } catch {} } }, 5000);
    ws.onmessage = e => {
      bin.last = Date.now();
      if (!got) {
        got = true; bin.retry = 0; bin.fails = 0;
        localStorage.setItem(HOST_KEY, String(bin.idx % BINANCE_HOSTS.length));
        state.status.binance = "live"; emit("status");
      }
      let d; try { d = JSON.parse(e.data); } catch { return; }
      if (d && d.data) handleBinance(d.data);
      emitSoon("spot", 400);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      clearTimeout(probe);
      bin.subs.clear();
      state.status.binance = "reconnecting"; emit("status");
      let delay;
      if (!got) { bin.idx++; bin.fails++; delay = bin.fails % BINANCE_HOSTS.length === 0 ? 15000 : 1500; }
      else delay = Math.min(30000, 1000 * 2 ** bin.retry++);
      bin.timer = setTimeout(connectBinance, delay);
    };
  }

  function handleBinance(x) {
    const asset = String(x.s || "").replace(/USDT$/, "");
    if (!asset) return;
    if (x.e === "24hrMiniTicker") {
      state.spot[asset] = { price: +x.c, ts: Date.now() };
    } else if (x.e === "kline" && x.k) {
      const tf = { "5m": 5, "15m": 15, "1h": 60 }[x.k.i];
      if (!tf) return;
      state.opens[`${asset}:${tf}:${x.k.t}`] = +x.k.o;
      const s = state.spot[asset];
      if (!s || Date.now() - s.ts > 1500) state.spot[asset] = { price: +x.k.c, ts: Date.now() };
    }
  }

  function reconnectAll() {
    if (!poly.ws || poly.ws.readyState > 1) { clearTimeout(poly.timer); poly.timer = null; poly.retry = 0; syncPoly(); }
    if (!bin.ws || bin.ws.readyState > 1) { clearTimeout(bin.timer); bin.timer = null; bin.retry = 0; syncBinance(); }
  }
  window.addEventListener("online", () => { limiter.pauseUntil = 0; reconnectAll(); discover(); });
  window.addEventListener("offline", () => { state.status.poly = "offline"; state.status.binance = "offline"; emit("status"); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) reconnectAll(); });

  /* ---------- settlement lookups ---------- */
  async function fetchResolutions(slugs) {
    const out = {};
    const unique = [...new Set(slugs)].filter(Boolean);
    const read = list => {
      for (const m of Array.isArray(list) ? list : []) {
        const outcomes = parseArr(m.outcomes).map(String);
        const prices = parseArr(m.outcomePrices).map(Number);
        const wi = prices.findIndex(p => p >= 0.99);
        out[m.slug] = { closed: !!m.closed, winner: m.closed && wi >= 0 ? outcomes[wi] : null };
      }
    };
    for (let i = 0; i < unique.length; i += 20) {
      const chunk = unique.slice(i, i + 20);
      read(await gamma(`/markets?${chunk.map(s => "slug=" + encodeURIComponent(s)).join("&")}&limit=${chunk.length}`));
      if (chunk.length > 1) for (const s of chunk) if (!out[s]) read(await gamma(`/markets?slug=${encodeURIComponent(s)}`));
    }
    return out;
  }

  /* ---------- helpers for the UI ---------- */
  const bookFor = token => state.books[token] || {};
  const openFor = m => state.opens[`${m.asset}:${m.tf}:${m.start}`] ?? null;
  const spotFor = asset => state.spot[asset]?.price ?? null;
  const markets = () => [...state.markets.values()];
  function watch({ tokens = [], assets = [] } = {}) {
    poly.extra = new Set(tokens); bin.extra = new Set(assets);
    syncPoly(); syncBinance();
  }

  return {
    state, on, discover, startLoop, setDiscoveryInterval: setInterval_, fetchResolutions,
    bookFor, openFor, spotFor, markets, watch, TIMEFRAMES
  };
})();
