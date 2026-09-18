/* BlueEdge live accounts
 * - Many accounts saved on this device, each encrypted with its own passcode (PBKDF2-SHA256 + AES-GCM).
 * - L1 (signer private key): Polymarket's official SDK signs orders and derives CLOB API credentials.
 * - L2 (CLOB API key/secret/passphrase): HMAC-signed CLOB requests for balance, open orders, fills and cancels.
 *   Placing orders always needs the signer private key, because every order carries an EIP-712 signature.
 */
window.BlueEdgeLive = (() => {
  const STORE = "blueedge.accounts.v2", OLD = "blueedge.vault.v1";
  const CLOB = "https://clob.polymarket.com", DATA = "https://data-api.polymarket.com";
  const ITER = 310000;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const WALLET_TYPES = { 0: "EOA", 1: "Proxy wallet", 2: "Safe wallet", 3: "Deposit wallet" };

  const state = {
    status: "none", message: "", activeId: null,
    account: null, canTrade: false, mode: null,         // mode: "sdk" (L1+L2) | "l2" (read-only)
    balance: null, orders: [], positions: [], trades: [], closed: [], closedAt: 0,
    lastRefresh: 0, refreshing: false, stream: "off",
    checks: [], checking: false, lastCheck: 0, approvalsMissing: false
  };
  let client = null, l2 = null, streamHandle = null, streamRetry = 0, timeOffset = 0, unlockedMeta = null;
  const listeners = [];
  const on = fn => listeners.push(fn);
  const emit = () => listeners.forEach(fn => { try { fn(state); } catch (e) { console.error(e); } });

  /* ---------- account store ---------- */
  function readStore() {
    let s; try { s = JSON.parse(localStorage.getItem(STORE) || "null"); } catch {}
    if (!s) {
      s = { active: null, list: [] };
      try {
        const v1 = JSON.parse(localStorage.getItem(OLD) || "null");
        if (v1?.ct) { const id = "acc_" + Date.now().toString(36); s.list.push({ ...v1, id, v: 1, hasKey: true, hasCreds: false, walletType: 3, updatedAt: v1.createdAt || Date.now() }); s.active = id; }
      } catch {}
      writeStore(s);
    }
    s.list = Array.isArray(s.list) ? s.list : [];
    return s;
  }
  function writeStore(s) { localStorage.setItem(STORE, JSON.stringify(s)); }
  const metaOf = r => r && ({ id: r.id, label: r.label, wallet: r.wallet, signer: r.signer, walletType: r.walletType ?? 3, hasKey: !!r.hasKey, hasCreds: !!r.hasCreds, hasRelayer: !!r.hasRelayer, relayerAddress: r.relayerAddress || "", createdAt: r.createdAt, updatedAt: r.updatedAt });
  const list = () => readStore().list.map(metaOf);
  const find = id => readStore().list.find(r => r.id === id);
  const active = () => { const s = readStore(); return metaOf(s.list.find(r => r.id === s.active) || null); };
  const hasVault = () => readStore().list.length > 0;
  const vaultInfo = active;

  /* ---------- crypto ---------- */
  function needCrypto() { if (!window.crypto?.subtle) throw new Error("Secure storage needs HTTPS. Open BlueEdge from its https:// address."); }
  async function deriveKey(passcode, salt) {
    needCrypto();
    const base = await crypto.subtle.importKey("raw", enc.encode(passcode), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function seal(payload, passcode) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passcode, salt);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(payload)));
    return { kdf: { name: "PBKDF2-SHA256", iter: ITER, salt: b64(salt) }, iv: b64(iv), ct: b64(ct) };
  }
  async function openRecord(r, passcode) {
    let key;
    try { key = await deriveKey(passcode, unb64(r.kdf.salt)); } catch (e) { throw e; }
    try { return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(r.iv) }, key, unb64(r.ct)))); }
    catch { throw new Error("Wrong passcode for this account."); }
  }

  /* ---------- input cleaning + validation ---------- */
  const strip = v => String(v ?? "").replace(/[\s"'`\u200B-\u200D\uFEFF]/g, "");
  const isAddr = a => /^0x[0-9a-fA-F]{40}$/.test(a);
  const short = a => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
  function cleanKey(raw) { let k = strip(raw); if (/^0X/.test(k)) k = "0x" + k.slice(2); if (/^[0-9a-fA-F]{64}$/.test(k)) k = "0x" + k; return k; }
  function cleanAddr(raw) { let a = strip(raw); if (/^0X/.test(a)) a = "0x" + a.slice(2); if (/^[0-9a-fA-F]{40}$/.test(a)) a = "0x" + a; return a; }
  function keyProblem(k) {
    if (/^0x[0-9a-fA-F]{64}$/.test(k)) return null;
    const bare = k.replace(/^0x/, "");
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(k)) return "That looks like an API key (it has dashes). The signer private key is 64 hex characters (0-9, a-f).";
    if (isAddr(k)) return "That's an address (40 characters), not a private key. The private key is 64 hex characters.";
    if (/[^0-9a-fA-F]/.test(bare)) return "That looks like an API secret, not a private key. The private key only uses 0-9 and a-f.";
    return `That key has ${bare.length} hex characters. A private key has exactly 64. Check that you copied all of it.`;
  }

  function validate(input) {
    const out = {
      label: String(input.label || "").trim().slice(0, 40) || "Polymarket account",
      wallet: cleanAddr(input.wallet),
      walletType: [0, 1, 2, 3].includes(Number(input.walletType)) ? Number(input.walletType) : 3,
      privateKey: cleanKey(input.privateKey),
      signer: cleanAddr(input.signer),
      apiKey: strip(input.apiKey), apiSecret: strip(input.apiSecret), apiPassphrase: strip(input.apiPassphrase),
      relayerKey: strip(input.relayerKey), relayerAddress: cleanAddr(input.relayerAddress)
    };
    const errs = [];
    if (!isAddr(out.wallet)) errs.push("Wallet address: enter the 0x… address from your Polymarket profile menu (42 characters).");
    if (out.privateKey) {
      const p = keyProblem(out.privateKey);
      if (p) errs.push("Signer private key: " + p);
      else {
        const derived = window.PolySDK?.privateKeyToAccount(out.privateKey).address;
        if (!derived) errs.push("The Polymarket SDK didn't load, so the key can't be checked. Reload the page.");
        else {
          if (out.signer && out.signer.toLowerCase() !== derived.toLowerCase())
            errs.push(`Signer private key: this key belongs to ${short(derived)}, not your signer address ${short(out.signer)}. You may have pasted the API passphrase instead of the private key.`);
          if (out.relayerAddress && out.relayerAddress.toLowerCase() !== derived.toLowerCase())
            errs.push(`Relayer address ${short(out.relayerAddress)} doesn't match this private key (${short(derived)}).`);
          out.signer = derived;
        }
      }
    }
    if (out.signer && !isAddr(out.signer)) errs.push("Signer address should be a 0x… address (42 characters).");
    const credCount = [out.apiKey, out.apiSecret, out.apiPassphrase].filter(Boolean).length;
    if (credCount && credCount < 3) errs.push("CLOB API credentials: enter all three (API key, secret and passphrase) or leave all three empty.");
    if (credCount === 3 && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(out.apiKey)) errs.push("CLOB API key should look like 01a0a9e4-0d88-7568-881d-b3814e37558f.");
    if (!out.privateKey && credCount < 3) errs.push("Add the signer private key to trade, or all three CLOB API credentials for a read-only account.");
    if (!out.privateKey && !out.signer) errs.push("Signer address is required when no private key is entered (it's shown next to your API key on Polymarket).");
    if (!!out.relayerKey !== !!out.relayerAddress) errs.push("Relayer: enter both the Relayer API key and its address, or leave both empty.");
    if (out.relayerAddress && !isAddr(out.relayerAddress)) errs.push("Relayer address should be a 0x… address.");
    const pass = String(input.passcode || "");
    if (pass.length < 8) errs.push("Passcode: use at least 8 characters.");
    if (input.passcode2 != null && pass !== String(input.passcode2)) errs.push("The two passcodes don't match.");
    if (errs.length) throw new Error(errs.join("\n"));
    return out;
  }

  /* ---------- save / remove / switch (works offline) ---------- */
  async function save(input) {
    const v = validate(input);
    const s = readStore();
    const existing = input.id ? s.list.find(r => r.id === input.id) : null;
    let cached = null;
    if (existing && input.oldPasscode) { try { cached = (await openRecord(existing, input.oldPasscode)).credentials || null; } catch {} }
    const payload = { privateKey: v.privateKey, wallet: v.wallet, walletType: v.walletType, signer: v.signer, relayerKey: v.relayerKey, relayerAddress: v.relayerAddress,
      manualCreds: v.apiKey ? { key: v.apiKey, secret: v.apiSecret, passphrase: v.apiPassphrase } : null, credentials: v.privateKey ? cached : null };
    const sealed = await seal(payload, input.passcode);
    const now = Date.now();
    const record = { app: "BlueEdge", v: 2, id: existing?.id || "acc_" + now.toString(36) + Math.random().toString(36).slice(2, 6), label: v.label, wallet: v.wallet, signer: v.signer, walletType: v.walletType,
      hasKey: !!v.privateKey, hasCreds: !!v.apiKey, hasRelayer: !!v.relayerKey, relayerAddress: v.relayerAddress, createdAt: existing?.createdAt || now, updatedAt: now, ...sealed };
    s.list = s.list.filter(r => r.id !== record.id).concat(record);
    s.active = record.id;
    writeStore(s);
    if (client || l2) await lock();
    state.activeId = record.id; state.status = "locked"; state.message = ""; emit();
    return metaOf(record);
  }
  async function remove(id) {
    if (state.activeId === id) await lock();
    const s = readStore();
    s.list = s.list.filter(r => r.id !== id);
    if (s.active === id) s.active = s.list[0]?.id || null;
    writeStore(s);
    state.activeId = s.active; state.status = s.active ? "locked" : "none"; emit();
  }
  async function setActive(id) {
    const s = readStore();
    if (!s.list.some(r => r.id === id)) return;
    if (state.activeId !== id) await lock();
    s.active = id; writeStore(s);
    state.activeId = id; state.status = client || l2 ? state.status : "locked"; emit();
  }

  /* ---------- connecting ---------- */
  const SDK = () => { if (!window.PolySDK) throw new Error("The Polymarket SDK didn't load. Reload the page."); return window.PolySDK; };
  function friendly(e) {
    const m = String(e?.message || e || "Unknown error");
    if (/failed to fetch|networkerror|load failed|cors/i.test(m)) return "Couldn't reach Polymarket. Check your connection. Polymarket may also block this network or region.";
    if (/restrict|geoblock|region|country|jurisdiction/i.test(m)) return "Polymarket doesn't allow trading from your current region.";
    if (/401|unauthori[sz]ed|invalid api key|api key/i.test(m)) return "Polymarket rejected the API credentials (401). Check the key, secret and passphrase, or leave them empty to create them from the private key.";
    if (/rate ?limit|429/i.test(m)) return "Polymarket is rate limiting. Wait a moment and try again.";
    return m.length > 240 ? m.slice(0, 240) + "…" : m;
  }

  async function unlock(id, passcode) {
    const r = find(id || state.activeId || readStore().active);
    if (!r) throw new Error("Choose an account first.");
    await lock();            // always start clean so one account's session never carries over to another
    await setActive(r.id);
    state.status = "unlocking"; state.message = "Unlocking…"; emit();
    let s;
    try { s = await openRecord(r, passcode); }
    catch (e) { state.status = "locked"; state.message = e.message; emit(); throw e; }

    let sdkError = null;
    if (s.privateKey) {
      try {
        state.message = "Signing in to Polymarket (L1)…"; emit();
        const { createSecureClient, privateKey, relayerApiKey } = SDK();
        const opts = { signer: privateKey(s.privateKey), wallet: s.wallet };
        if (s.relayerKey && s.relayerAddress) opts.apiKey = relayerApiKey({ key: s.relayerKey, address: s.relayerAddress });
        const creds = s.manualCreds || s.credentials;
        let c = null;
        if (creds) { try { c = await createSecureClient({ ...opts, credentials: creds }); } catch (e) { console.warn("Saved credentials rejected; deriving new ones", e); } }
        if (!c) c = await createSecureClient(opts);
        client = c;
        if (c.credentials && JSON.stringify(c.credentials) !== JSON.stringify(s.credentials)) {
          s.credentials = c.credentials;
          const st = readStore(), rec = st.list.find(x => x.id === r.id);
          if (rec) { Object.assign(rec, await seal(s, passcode), { updatedAt: Date.now() }); writeStore(st); }
        }
      } catch (e) { sdkError = friendly(e); client = null; }
    }
    const creds = s.manualCreds || s.credentials;
    if (!client && creds) l2 = { key: creds.key || creds.apiKey, secret: creds.secret, passphrase: creds.passphrase, signer: s.signer, wallet: s.wallet, walletType: s.walletType ?? 3 };
    if (!client && !l2) { state.status = "locked"; state.message = sdkError || "Couldn't connect."; emit(); throw new Error(state.message + " Your account is still saved: fix it with Edit, or try again."); }

    unlockedMeta = metaOf(r);
    state.mode = client ? "sdk" : "l2";
    state.canTrade = !!client;
    state.account = client ? { ...client.account } : { wallet: s.wallet, signer: s.signer, walletType: s.walletType ?? 3 };
    state.status = "live";
    state.message = sdkError ? `Read-only: trading is unavailable (${sdkError})` : "";
    emit();
    if (client) startStream();
    await refresh(true);
    return state;
  }

  async function lock() {
    stopStream();
    try { await client?.closeSubscriptions?.(); } catch {}
    client = null; l2 = null; unlockedMeta = null;
    Object.assign(state, { status: hasVault() ? "locked" : "none", message: "", account: null, canTrade: false, mode: null, balance: null, orders: [], positions: [], trades: [], closed: [], closedAt: 0, checks: [], approvalsMissing: false });
    emit();
  }

  async function reveal(id, passcode) {
    const r = find(id);
    if (!r) throw new Error("Account not found.");
    const s = await openRecord(r, passcode);
    const c = s.manualCreds || s.credentials || {};
    return { id: r.id, label: r.label, wallet: s.wallet, walletType: s.walletType ?? 3, signer: s.signer, privateKey: s.privateKey || "",
      apiKey: c.key || c.apiKey || "", apiSecret: c.secret || "", apiPassphrase: c.passphrase || "", credsSource: s.manualCreds ? "entered" : s.credentials ? "created from private key" : "",
      relayerKey: s.relayerKey || "", relayerAddress: s.relayerAddress || "" };
  }

  /* ---------- accounts file (all accounts, still encrypted) ---------- */
  function exportFile() {
    const s = readStore();
    if (!s.list.length) throw new Error("No accounts to save.");
    const blob = new Blob([JSON.stringify({ app: "BlueEdge", kind: "accounts", v: 2, exportedAt: new Date().toISOString(), accounts: s.list }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `blueedge-accounts-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return s.list.length;
  }
  async function importFile(file) {
    let j;
    try { j = JSON.parse(await file.text()); } catch { throw new Error("That file isn't valid JSON."); }
    const incoming = Array.isArray(j?.accounts) ? j.accounts : j?.ct ? [j] : [];
    const valid = incoming.filter(r => r && r.ct && r.iv && r.kdf?.salt && isAddr(r.wallet));
    if (!valid.length) throw new Error("No BlueEdge accounts found in that file.");
    const s = readStore();
    let added = 0, updated = 0;
    for (const r0 of valid) {
      const r = { v: 2, hasKey: true, walletType: 3, ...r0, id: r0.id || "acc_" + Math.random().toString(36).slice(2, 10) };
      const i = s.list.findIndex(x => x.id === r.id);
      if (i < 0) { s.list.push(r); added++; }
      else if ((r.updatedAt || 0) >= (s.list[i].updatedAt || 0)) { s.list[i] = r; updated++; }
    }
    if (!s.active) s.active = s.list[0].id;
    writeStore(s);
    state.activeId = s.active; if (!client && !l2) state.status = "locked";
    emit();
    return { added, updated };
  }

  /* ---------- L2: HMAC-signed CLOB requests ---------- */
  let l2Last = 0;
  async function l2Fetch(method, path, { query = "", body = null } = {}) {
    if (!l2) throw new Error("No API credentials loaded.");
    const wait = 250 - (Date.now() - l2Last); if (wait > 0) await new Promise(r => setTimeout(r, wait));
    l2Last = Date.now();
    const ts = Math.floor(Date.now() / 1000) + timeOffset;
    const bodyStr = body ? JSON.stringify(body) : "";
    const secret = unb64(l2.secret.replace(/-/g, "+").replace(/_/g, "/"));
    const hk = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = b64(await crypto.subtle.sign("HMAC", hk, enc.encode(`${ts}${method}${path}${bodyStr}`))).replace(/\+/g, "-").replace(/\//g, "_");
    const headers = { POLY_ADDRESS: l2.signer, POLY_SIGNATURE: sig, POLY_TIMESTAMP: String(ts), POLY_API_KEY: l2.key, POLY_PASSPHRASE: l2.passphrase };
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(CLOB + path + (query ? "?" + query : ""), { method, headers, body: bodyStr || undefined, cache: "no-store" });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) throw new Error(`${res.status} ${typeof data === "object" ? data.error || data.message || "" : text}`.trim());
    return data;
  }
  async function syncTime() { try { const r = await fetch(CLOB + "/time", { cache: "no-store" }); const t = Number(await r.text()); if (t > 1e9) timeOffset = Math.round(t - Date.now() / 1000); } catch {} }
  const rows = d => Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  const mapOrder = o => ({ id: o.id, assetId: String(o.asset_id ?? o.assetId ?? ""), side: o.side, price: o.price, originalSize: o.original_size ?? o.originalSize, sizeMatched: o.size_matched ?? o.sizeMatched, outcome: o.outcome, orderType: o.order_type ?? o.orderType, status: o.status });
  const mapTrade = t => ({ assetId: String(t.asset_id ?? t.assetId ?? ""), side: t.side, size: t.size, price: t.price, status: t.status, matchTime: t.match_time ?? t.matchTime ?? t.created_at, outcome: t.outcome });
  async function publicPositions(wallet) {
    const r = await fetch(`${DATA}/positions?user=${wallet}&sizeThreshold=0.01&limit=500`, { cache: "no-store" });
    if (!r.ok) throw new Error(`Positions ${r.status}`);
    return rows(await r.json()).map(p => ({ assetId: String(p.asset), conditionId: p.conditionId, currentSize: p.size, avgPrice: p.avgPrice, currentPrice: p.curPrice, currentValue: p.currentValue, totalCostUsdc: p.initialValue, cashPnl: p.cashPnl, title: p.title, outcome: p.outcome, slug: p.slug, eventSlug: p.eventSlug, endDate: p.endDate, redeemable: p.redeemable }));
  }
  async function publicClosed(wallet) {
    const r = await fetch(`${DATA}/closed-positions?user=${wallet}&limit=50&sortBy=TIMESTAMP&sortDirection=DESC`, { cache: "no-store" });
    if (!r.ok) throw new Error(`Closed positions ${r.status}`);
    return rows(await r.json()).map(p => ({ assetId: String(p.asset), conditionId: p.conditionId, avgPrice: p.avgPrice, totalBought: p.totalBought, realizedPnl: p.realizedPnl, currentPrice: p.curPrice, title: p.title, outcome: p.outcome, slug: p.slug, eventSlug: p.eventSlug, timestamp: p.timestamp, endDate: p.endDate }));
  }
  // walk SDK paginators a few pages deep so the whole account shows, without hammering the API
  async function allItems(paginator, maxPages = 5) {
    const out = [];
    let page = await paginator.firstPage();
    for (let i = 0; page && i < maxPages; i++) {
      out.push(...(page.items || []));
      const next = typeof page.nextPage === "function" ? page.nextPage : typeof page.next === "function" ? page.next : null;
      if (!next || page.hasNextPage === false || !(page.items || []).length) break;
      try { page = await next.call(page); } catch { break; }
    }
    return out;
  }
  async function l2All(path, maxPages = 5) {
    const out = []; let cursor = "";
    for (let i = 0; i < maxPages; i++) {
      const d = await l2Fetch("GET", path, { query: cursor ? `next_cursor=${encodeURIComponent(cursor)}` : "" });
      out.push(...rows(d));
      cursor = d?.next_cursor;
      if (!cursor || cursor === "LTE=") break;
    }
    return out;
  }

  /* ---------- account data ---------- */
  let refreshTimer = null;
  function refreshSoon(ms = 1500) { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh(true), ms); }
  const firstItems = async p => (await p.firstPage())?.items || [];

  async function refresh(force = false) {
    if ((!client && !l2) || state.refreshing) return;
    if (!force && Date.now() - state.lastRefresh < 8000) return;
    state.refreshing = true; emit();
    try {
      let results;
      if (client) {
        const wallet = state.account?.wallet;
        results = await Promise.allSettled([
          fetchCollateralBalance(),
          allItems(client.listOpenOrders(), 5),
          wallet ? publicPositions(wallet).catch(() => allItems(client.listPositions(), 5)) : allItems(client.listPositions(), 5),
          allItems(client.listAccountTrades(), 3)
        ]);
      } else {
        if (!timeOffset) await syncTime();
        results = await Promise.allSettled([
          l2Fetch("GET", "/balance-allowance", { query: `asset_type=COLLATERAL&signature_type=${l2.walletType}` }).then(b => Number(b.balance) / 1e6),
          l2All("/data/orders", 5).then(r => r.map(mapOrder)),
          publicPositions(l2.wallet),
          l2All("/data/trades", 3).then(r => r.map(mapTrade))
        ]);
      }
      const [bal, orders, positions, trades] = results;
      if (bal.status === "fulfilled" && Number.isFinite(bal.value)) state.balance = bal.value;
      if (orders.status === "fulfilled") state.orders = orders.value;
      if (positions.status === "fulfilled") state.positions = positions.value.filter(p => Number(p.currentSize ?? p.size ?? 0) > 0);
      if (trades.status === "fulfilled") state.trades = trades.value.slice(0, 300);
      const wallet = state.account?.wallet || l2?.wallet;
      if (wallet && Date.now() - state.closedAt > 60000) { state.closedAt = Date.now(); publicClosed(wallet).then(c => { state.closed = c; emit(); }).catch(() => {}); }
      const failed = results.find(r => r.status === "rejected");
      state.message = failed ? friendly(failed.reason) : (state.canTrade ? "" : state.message);
      state.lastRefresh = Date.now();
    } finally { state.refreshing = false; emit(); }
  }

  async function startStream() {
    stopStream();
    if (!client) return;
    const retry = () => { state.stream = "reconnecting"; emit(); setTimeout(() => { if (client) startStream(); }, Math.min(30000, 2000 * 2 ** streamRetry++)); };
    try {
      state.stream = "connecting"; emit();
      const handle = await client.subscribe([{ topic: "user" }]);
      streamHandle = handle; streamRetry = 0; state.stream = "live"; emit();
      (async () => {
        try { for await (const _e of handle) refreshSoon(1000); } catch (e) { console.warn("User stream ended", e); }
        if (streamHandle === handle && client) retry();
      })();
    } catch (e) { console.warn("User stream failed", e); retry(); }
  }
  function stopStream() { const h = streamHandle; streamHandle = null; state.stream = "off"; try { h?.close?.(); } catch {} }

  // Backup polling: 20s visible, 90s hidden (L2 read-only has no user stream, so it polls every 15s)
  setInterval(() => {
    if (!client && !l2) return;
    const every = document.hidden ? 90000 : client && state.stream === "live" ? 20000 : 15000;
    if (Date.now() - state.lastRefresh >= every) refresh(true);
  }, 3000);
  window.addEventListener("online", () => { if (client) startStream(); if (client || l2) refreshSoon(500); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && (client || l2) && Date.now() - state.lastRefresh > 8000) refreshSoon(300); });

  /* ---------- connection check (rate-limited: once per 15s) ---------- */
  async function check() {
    if (state.checking) return state.checks;
    const wait = 15000 - (Date.now() - state.lastCheck);
    if (wait > 0) throw new Error(`Checked a moment ago. Try again in ${Math.ceil(wait / 1000)}s.`);
    if (!client && !l2) throw new Error("Unlock the account first.");
    state.checking = true; state.lastCheck = Date.now(); state.checks = []; emit();
    const add = (name, ok, detail) => { state.checks.push({ name, ok, detail }); emit(); };
    const meta = unlockedMeta || active();
    add("Saved on this device", true, `${meta.label}, encrypted with your passcode`);
    // Signing in (L1) already succeeded by the time `client` exists, so it's not a separate pass/fail gate —
    // only show it as its own line when there's no client, to explain why the account is read-only.
    if (!client) add("Signer key", meta.hasKey ? false : null, meta.hasKey ? "Private key saved but Polymarket sign-in failed." : "No private key. This account is read-only and can't place orders.");
    try {
      let bal;
      if (client) { bal = await fetchCollateralBalance(); }
      else bal = Number((await l2Fetch("GET", "/balance-allowance", { query: `asset_type=COLLATERAL&signature_type=${l2.walletType}` })).balance) / 1e6;
      state.balance = bal;
      add("Polymarket connection", true, client ? `Signed in as ${short(state.account.signer)}. Orders can be signed.` : "Polymarket accepted the signed balance request.");
      add("Cash balance", bal > 0, `$${bal.toFixed(2)} pUSD available${bal > 0 ? "" : ". Deposit on polymarket.com to trade."}`);
    } catch (e) { add("Polymarket connection", false, friendly(e)); }
    if (client) {
      try { const closedOnly = await client.fetchClosedOnlyMode?.(); if (closedOnly != null) add("Account can open positions", !closedOnly, closedOnly ? "Polymarket has this account in close-only mode." : "Not in close-only mode."); } catch {}
      try {
        const ap = await client.fetchTradingApprovalsState();
        state.approvalsMissing = !ap.isFullyApproved;
        add("Trading approvals", ap.isFullyApproved, ap.isFullyApproved ? "Exchange contracts are approved to use your pUSD and shares." : (meta.hasRelayer ? "Some approvals are missing. Use Set up approvals below." : "Some approvals are missing. Add a Relayer API key, or place one trade on polymarket.com to set them up."));
      } catch (e) { add("Trading approvals", null, `Couldn't check: ${friendly(e)}`); }
      add("Live order updates", state.stream === "live", state.stream === "live" ? "Streaming from Polymarket." : `Stream ${state.stream}.`);
    }
    try {
      const r = await fetch("https://polymarket.com/api/geoblock", { cache: "no-store" });
      const g = await r.json();
      add("Region", !g.blocked, g.blocked ? `Polymarket blocks trading from ${g.country || "your region"}${g.region ? " (" + g.region + ")" : ""}.` : `Trading allowed from ${g.country || "your region"}.`);
    } catch { add("Region", null, "Couldn't check from the browser. Order errors will say if your region is blocked."); }
    state.checking = false; emit();
    refreshSoon(500);
    return state.checks;
  }
  async function setupApprovals() {
    if (!client) throw new Error("Unlock an account with a private key first.");
    try { await client.setupTradingApprovals(); state.approvalsMissing = false; emit(); }
    catch (e) { throw new Error(friendly(e)); }
  }

  /* ---------- trading ---------- */
  const needTrade = () => { if (!client) throw new Error(l2 ? "This account is read-only. Add the signer private key (Edit account) to place orders." : "Unlock your live account first."); };
  async function buy({ tokenId, usd, maxPrice }) {
    needTrade();
    const amount = Math.floor(usd * 100) / 100;
    if (!(amount >= 1)) throw new Error("Live orders need at least $1.");
    try {
      const res = await client.placeMarketOrder({ assetId: String(tokenId), side: "BUY", amount: amount.toFixed(2), maxPrice: String(+Math.min(0.99, maxPrice).toFixed(3)), orderType: "FAK" });
      if (res && res.ok === false) throw new Error(res.message || res.code || "Order rejected");
      refreshSoon(1200); setTimeout(() => refresh(true), 5000);
      return res;
    } catch (e) { throw new Error(friendly(e)); }
  }
  async function sell({ tokenId, shares, minPrice }) {
    needTrade();
    try {
      const res = await client.placeMarketOrder({ assetId: String(tokenId), side: "SELL", shares: String(Math.floor(shares * 100) / 100), minPrice: String(+Math.max(0.01, minPrice).toFixed(3)), orderType: "FAK" });
      if (res && res.ok === false) throw new Error(res.message || res.code || "Order rejected");
      refreshSoon(1200); setTimeout(() => refresh(true), 5000);
      return res;
    } catch (e) { throw new Error(friendly(e)); }
  }
  async function cancel(orderId) {
    try { if (client) await client.cancelOrder({ orderId }); else await l2Fetch("DELETE", "/order", { body: { orderID: orderId } }); refreshSoon(700); }
    catch (e) { throw new Error(friendly(e)); }
  }
  async function cancelAll() {
    try { if (client) await client.cancelAll(); else await l2Fetch("DELETE", "/cancel-all"); refreshSoon(700); }
    catch (e) { throw new Error(friendly(e)); }
  }

  // Newer Polymarket SDK builds dropped client.fetchBalanceAllowance({assetType}) in favor of a no-arg
  // client.fetchBalances() that returns every asset the account holds: [{asset:"COLLATERAL"|tokenId, balance, value}].
  // Use the COLLATERAL row's `value` (already USD-denominated) so we don't have to guess whether `balance`
  // is a raw micro-USDC integer or already scaled.
  async function fetchCollateralBalance() {
    const rows = await client.fetchBalances();
    const arr = Array.isArray(rows) ? rows : rows?.data || [];
    const c = arr.find(b => String(b?.asset).toUpperCase() === "COLLATERAL");
    if (!c) return 0;
    const v = Number(c.value);
    if (Number.isFinite(v)) return v;
    const b = Number(c.balance);
    return Number.isFinite(b) ? (b > 1000 ? b / 1e6 : b) : 0; // fallback if `value` is ever missing
  }

  const isUnlocked = () => !!(client || l2);
  const canTrade = () => !!client;
  const equity = () => (state.balance || 0) + state.positions.reduce((s, p) => s + Number(p.currentValue || 0), 0);

  (() => { const s = readStore(); state.activeId = s.active; if (s.list.length) state.status = "locked"; })();
  return { state, on, list, active, vaultInfo, hasVault, save, remove, setActive, unlock, lock, reveal, exportFile, importFile, refresh, check, setupApprovals, buy, sell, cancel, cancelAll, isUnlocked, canTrade, equity, WALLET_TYPES, validate };
})();
