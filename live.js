/* BlueEdge live account
 * Uses Polymarket's official TypeScript SDK (@polymarket/client, bundled in polymarket-sdk.js).
 * Secrets are encrypted on this device with the user's passcode (PBKDF2-SHA256 + AES-GCM) and are only
 * decrypted into memory while the account is unlocked. They are sent nowhere except Polymarket's own APIs.
 */
window.BlueEdgeLive = (() => {
  const VAULT_KEY = "blueedge.vault.v1";
  const ITER = 310000;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  const state = {
    status: "none",          // none | locked | unlocking | live
    message: "",
    account: null,           // { wallet, signer, walletType }
    balance: null,           // pUSD available
    orders: [], positions: [], trades: [],
    lastRefresh: 0, refreshing: false, stream: "off"
  };
  let client = null, streamHandle = null, streamRetry = 0;
  const listeners = [];
  const on = fn => listeners.push(fn);
  const emit = () => listeners.forEach(fn => { try { fn(state); } catch (e) { console.error(e); } });

  /* ---------- vault ---------- */
  const readVault = () => { try { return JSON.parse(localStorage.getItem(VAULT_KEY) || "null"); } catch { return null; } };
  const hasVault = () => !!readVault();
  const vaultInfo = () => {
    const v = readVault();
    return v ? { label: v.label, wallet: v.wallet, signer: v.signer, relayerAddress: v.relayerAddress, hasRelayer: v.hasRelayer, createdAt: v.createdAt } : null;
  };
  const metaOf = v => ({ label: v.label, wallet: v.wallet, signer: v.signer, relayerAddress: v.relayerAddress, hasRelayer: v.hasRelayer, createdAt: v.createdAt });

  async function deriveKey(passcode, salt) {
    if (!window.crypto?.subtle) throw new Error("Secure storage needs HTTPS. Open BlueEdge from its https:// GitHub Pages address.");
    const base = await crypto.subtle.importKey("raw", enc.encode(passcode), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function seal(payload, passcode, meta) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passcode, salt);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(payload)));
    return { app: "BlueEdge", v: 1, ...meta, kdf: { name: "PBKDF2-SHA256", iter: ITER, salt: b64(salt) }, iv: b64(iv), ct: b64(ct) };
  }
  async function openVault(vault, passcode) {
    try {
      const key = await deriveKey(passcode, unb64(vault.kdf.salt));
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(vault.iv) }, key, unb64(vault.ct));
      return JSON.parse(dec.decode(pt));
    } catch (e) { if (/HTTPS/.test(e.message)) throw e; throw new Error("Wrong passcode."); }
  }

  /* ---------- helpers ---------- */
  const SDK = () => { if (!window.PolySDK) throw new Error("The Polymarket SDK didn't load."); return window.PolySDK; };
  const isAddr = a => /^0x[0-9a-fA-F]{40}$/.test(String(a || "").trim());
  const normKey = k => { k = String(k || "").trim(); return /^[0-9a-fA-F]{64}$/.test(k) ? "0x" + k : k; };
  const short = a => `${a.slice(0, 6)}…${a.slice(-4)}`;
  function friendly(e) {
    const m = String(e?.message || e || "Unknown error");
    if (/failed to fetch|networkerror|load failed|cors/i.test(m)) return "Couldn't reach Polymarket. Check your connection. Polymarket may also block this network or region.";
    if (/restrict|geoblock|region|country|jurisdiction/i.test(m)) return "Polymarket doesn't allow order placement from your current region.";
    if (/rate ?limit|429/i.test(m)) return "Polymarket is rate limiting. BlueEdge will slow down and retry.";
    return m.length > 220 ? m.slice(0, 220) + "…" : m;
  }

  async function buildClient(s) {
    const { createSecureClient, privateKey, relayerApiKey } = SDK();
    const opts = { signer: privateKey(s.privateKey), wallet: s.wallet };
    if (s.relayerKey && s.relayerAddress) opts.apiKey = relayerApiKey({ key: s.relayerKey, address: s.relayerAddress });
    if (s.credentials) {
      try { return await createSecureClient({ ...opts, credentials: s.credentials }); }
      catch (e) { console.warn("Saved CLOB credentials were rejected, deriving new ones.", e); }
    }
    return createSecureClient(opts);
  }

  /* ---------- connect / unlock / lock / disconnect ---------- */
  async function connect({ label, wallet, privateKey: pk, relayerKey, relayerAddress, passcode }) {
    pk = normKey(pk);
    wallet = String(wallet || "").trim();
    relayerKey = String(relayerKey || "").trim();
    relayerAddress = String(relayerAddress || "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("The signer private key should be 64 hex characters (with or without 0x).");
    if (!isAddr(wallet)) throw new Error("Enter your Polymarket wallet address (the 0x… address in your profile menu).");
    if (relayerAddress && !isAddr(relayerAddress)) throw new Error("The relayer address doesn't look like a 0x address.");
    if (!!relayerKey !== !!relayerAddress) throw new Error("Enter both the Relayer API key and its address, or leave both empty.");
    if (String(passcode || "").length < 8) throw new Error("Use a passcode of at least 8 characters.");
    const signer = SDK().privateKeyToAccount(pk).address;
    if (relayerAddress && signer.toLowerCase() !== relayerAddress.toLowerCase())
      throw new Error(`That private key belongs to ${short(signer)}, but the relayer key is for ${short(relayerAddress)}. Use the key for the Signer Address Polymarket shows.`);

    state.status = "unlocking"; state.message = "Connecting to Polymarket…"; emit();
    try {
      const s = { privateKey: pk, wallet, relayerKey, relayerAddress };
      const c = await buildClient(s);
      s.credentials = c.credentials;
      const vault = await seal(s, passcode, {
        label: String(label || "").trim() || "Polymarket account",
        wallet: c.account?.wallet || wallet, signer, relayerAddress, hasRelayer: !!relayerKey, createdAt: Date.now()
      });
      localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
      await activate(c);
    } catch (e) {
      state.status = hasVault() ? "locked" : "none"; state.message = friendly(e); emit();
      throw new Error(state.message);
    }
  }

  async function unlock(passcode) {
    const v = readVault();
    if (!v) throw new Error("No account is connected on this device.");
    state.status = "unlocking"; state.message = "Unlocking…"; emit();
    try {
      const s = await openVault(v, passcode);
      const c = await buildClient(s);
      if (c.credentials && JSON.stringify(c.credentials) !== JSON.stringify(s.credentials)) {
        s.credentials = c.credentials;
        localStorage.setItem(VAULT_KEY, JSON.stringify(await seal(s, passcode, metaOf(v))));
      }
      await activate(c);
    } catch (e) {
      state.status = "locked"; state.message = friendly(e); emit();
      throw new Error(state.message);
    }
  }

  async function activate(c) {
    client = c;
    state.account = { ...c.account };
    state.status = "live"; state.message = "";
    emit();
    startStream();
    await refresh(true);
  }

  async function lock() {
    stopStream();
    try { await client?.closeSubscriptions?.(); } catch {}
    client = null;
    Object.assign(state, { status: hasVault() ? "locked" : "none", message: "", balance: null, orders: [], positions: [], trades: [], account: null });
    emit();
  }

  async function disconnect() {
    await lock();
    localStorage.removeItem(VAULT_KEY);
    state.status = "none"; emit();
  }

  async function reveal(passcode) {
    const v = readVault();
    if (!v) throw new Error("No account is connected.");
    const s = await openVault(v, passcode);
    return { label: v.label, wallet: v.wallet, signer: v.signer, privateKey: s.privateKey, relayerKey: s.relayerKey || "", relayerAddress: s.relayerAddress || "", credentials: s.credentials || null };
  }

  /* ---------- account file: encrypted JSON saved on the device ---------- */
  function exportFile() {
    const v = readVault();
    if (!v) throw new Error("No account to save.");
    const blob = new Blob([JSON.stringify(v, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `blueedge-account-${String(v.wallet || "").slice(2, 8)}.json`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function importFile(file) {
    let v;
    try { v = JSON.parse(await file.text()); } catch { throw new Error("That file isn't valid JSON."); }
    if (v?.app !== "BlueEdge" || !v.ct || !v.iv || !v.kdf?.salt || !isAddr(v.wallet)) throw new Error("That isn't a BlueEdge account file.");
    await lock();
    localStorage.setItem(VAULT_KEY, JSON.stringify(v));
    state.status = "locked"; emit();
    return vaultInfo();
  }

  /* ---------- account data (stream-driven, polling only as a backup) ---------- */
  const firstItems = async paginator => (await paginator.firstPage())?.items || [];
  let refreshTimer = null;
  function refreshSoon(ms = 1500) { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh(true), ms); }

  async function refresh(force = false) {
    if (!client || state.refreshing) return;
    if (!force && Date.now() - state.lastRefresh < 10000) return;
    state.refreshing = true;
    try {
      const { AssetType } = SDK();
      const results = await Promise.allSettled([
        client.fetchBalanceAllowance({ assetType: AssetType.COLLATERAL }),
        firstItems(client.listOpenOrders()),
        firstItems(client.listPositions()),
        firstItems(client.listAccountTrades())
      ]);
      const [bal, orders, positions, trades] = results;
      if (bal.status === "fulfilled") state.balance = Number(bal.value.balance) / 1e6;
      if (orders.status === "fulfilled") state.orders = orders.value;
      if (positions.status === "fulfilled") state.positions = positions.value.filter(p => Number(p.currentSize ?? p.size ?? 0) > 0);
      if (trades.status === "fulfilled") state.trades = trades.value.slice(0, 50);
      const failed = results.find(r => r.status === "rejected");
      state.message = failed ? friendly(failed.reason) : "";
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
      streamHandle = handle; streamRetry = 0;
      state.stream = "live"; emit();
      (async () => {
        try { for await (const _event of handle) refreshSoon(1200); }
        catch (e) { console.warn("User stream ended", e); }
        if (streamHandle === handle && client) retry();
      })();
    } catch (e) { console.warn("User stream failed", e); retry(); }
  }
  function stopStream() { const h = streamHandle; streamHandle = null; state.stream = "off"; try { h?.close?.(); } catch {} }

  setInterval(() => { if (client && Date.now() - state.lastRefresh >= (document.hidden ? 90000 : 30000)) refresh(true); }, 5000);
  window.addEventListener("online", () => { if (client) { startStream(); refreshSoon(500); } });

  /* ---------- trading ---------- */
  const need = () => { if (!client) throw new Error("Unlock your live account first."); };

  async function buy({ tokenId, usd, maxPrice }) {
    need();
    const amount = Math.floor(usd * 100) / 100;
    if (!(amount >= 1)) throw new Error("Live orders need at least $1.");
    try {
      const res = await client.placeMarketOrder({
        assetId: String(tokenId), side: "BUY", amount: amount.toFixed(2),
        maxPrice: String(+Math.min(0.99, maxPrice).toFixed(3)), orderType: "FAK"
      });
      if (res && res.ok === false) throw new Error(res.message || res.code || "Order rejected");
      refreshSoon(1500);
      return res;
    } catch (e) { throw new Error(friendly(e)); }
  }
  async function sell({ tokenId, shares, minPrice }) {
    need();
    try {
      const res = await client.placeMarketOrder({
        assetId: String(tokenId), side: "SELL", shares: String(Math.floor(shares * 100) / 100),
        minPrice: String(+Math.max(0.01, minPrice).toFixed(3)), orderType: "FAK"
      });
      if (res && res.ok === false) throw new Error(res.message || res.code || "Order rejected");
      refreshSoon(1500);
      return res;
    } catch (e) { throw new Error(friendly(e)); }
  }
  async function cancel(orderId) { need(); try { await client.cancelOrder({ orderId }); refreshSoon(800); } catch (e) { throw new Error(friendly(e)); } }
  async function cancelAll() { need(); try { await client.cancelAll(); refreshSoon(800); } catch (e) { throw new Error(friendly(e)); } }

  const isUnlocked = () => !!client;
  const equity = () => (state.balance || 0) + state.positions.reduce((s, p) => s + Number(p.currentValue || 0), 0);

  if (hasVault()) state.status = "locked";
  return { state, on, hasVault, vaultInfo, connect, unlock, lock, disconnect, reveal, exportFile, importFile, refresh, buy, sell, cancel, cancelAll, isUnlocked, equity };
})();
