window.BlueEdgeData = (() => {
  const GAMMA = "https://gamma-api.polymarket.com/markets";
  const BINANCE_WS = "wss://stream.binance.com:9443/stream?streams=btcusdt@ticker/ethusdt@ticker/solusdt@ticker";
  const state = { prices:{BTC:null,ETH:null,SOL:null}, ws:null, markets:[], lastFetch:0 };

  function safeJSON(v, fallback=[]){ try{return JSON.parse(v)}catch{return fallback} }

  async function fetchMarkets() {
    const url = GAMMA + "?active=true&closed=false&limit=100&order=endDate&ascending=true";
    const res = await fetch(url, {cache:"no-store"});
    if(!res.ok) throw new Error("Polymarket market request failed: "+res.status);
    const raw = await res.json();
    state.markets = raw.filter(m => {
      const q=(m.question||"").toLowerCase();
      const c=(m.category||"").toLowerCase();
      return /bitcoin|btc|ethereum|eth|solana|sol/.test(q+" "+c);
    }).map(normalizeMarket).slice(0,30);
    state.lastFetch=Date.now();
    return state.markets;
  }

  function normalizeMarket(m){
    const outcomes=safeJSON(m.outcomes);
    const prices=safeJSON(m.outcomePrices).map(Number);
    const q=(m.question||"").toLowerCase();
    let asset=q.includes("bitcoin")||q.includes("btc")?"BTC":q.includes("ethereum")||q.includes("eth")?"ETH":q.includes("solana")||q.includes("sol")?"SOL":"CRYPTO";
    const duration=Math.max(0,(new Date(m.endDate||0)-new Date(m.startDate||0))/60000);
    return {id:m.id,question:m.question||"Crypto market",slug:m.slug,endDate:m.endDate,startDate:m.startDate,asset,
      yes:prices[outcomes.findIndex(x=>String(x).toLowerCase()==="yes")] ?? prices[0] ?? .5,
      no:prices[outcomes.findIndex(x=>String(x).toLowerCase()==="no")] ?? prices[1] ?? .5,
      volume:Number(m.volumeNum||m.volume||0),liquidity:Number(m.liquidityNum||m.liquidity||0),duration};
  }

  function connectBinance(onUpdate,onStatus){
    try{
      const ws=new WebSocket(BINANCE_WS); state.ws=ws;
      ws.onopen=()=>onStatus?.("Binance live");
      ws.onmessage=e=>{
        const msg=JSON.parse(e.data); const d=msg.data||msg;
        const symbol=(d.s||"").toUpperCase(); const asset=symbol.replace("USDT","");
        if(state.prices[asset]!==undefined){state.prices[asset]=Number(d.c);onUpdate?.(asset,state.prices[asset],d);}
      };
      ws.onerror=()=>onStatus?.("Binance reconnecting");
      ws.onclose=()=>{onStatus?.("Binance offline");setTimeout(()=>connectBinance(onUpdate,onStatus),5000)};
    }catch{onStatus?.("Binance unavailable")}
  }

  return {state,fetchMarkets,connectBinance};
})();
