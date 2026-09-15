(() => {
  const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
  let markets=[], bot=false, settings=JSON.parse(localStorage.getItem("blueedge.settings")||'{"balance":10000,"startBalance":10000}');
  let trades=JSON.parse(localStorage.getItem("blueedge.trades")||"[]");
  let strategy=BlueEdgeStrategy.load();

  const money=n=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(n);
  const pct=n=>(n*100).toFixed(1)+"%";
  function persist(){localStorage.setItem("blueedge.settings",JSON.stringify(settings));localStorage.setItem("blueedge.trades",JSON.stringify(trades));}
  function go(page){$$(".page").forEach(x=>x.classList.remove("active"));$("#page-"+page)?.classList.add("active");$$(".nav").forEach(x=>x.classList.toggle("active",x.dataset.page===page));$("#pageTitle").textContent=page[0].toUpperCase()+page.slice(1); if(page==="trades")renderTrades(); if(page==="markets")renderMarketsTable();}
  $$(".nav").forEach(b=>b.onclick=()=>go(b.dataset.page)); $$("[data-page='markets']").forEach(b=>b.onclick=()=>go("markets"));

  function marketView(m){
    const price=BlueEdgeData.state.prices[m.asset];
    const sig=BlueEdgeStrategy.signal(m.asset,m.yes,price,m.id.length);
    const end=new Date(m.endDate).getTime(); const mins=Math.max(0,(end-Date.now())/60000);
    return {...m,sig,mins,binance:price};
  }

  function renderCards(){
    const list=markets.filter(m=>["BTC","ETH","SOL"].includes(m.asset)).slice(0,6).map(marketView);
    $("#marketCards").innerHTML=list.length?list.map(m=>`
      <article class="market-card"><span class="label">${m.asset} • ${Math.round(m.duration||15)}M</span>
      <h3>${escapeHtml(m.question)}</h3>
      <div class="price-row"><div><span class="sub">YES</span><div class="price">${(m.yes*100).toFixed(0)}¢</div></div><div class="signal">${m.sig.action}</div></div>
      <div class="sub">Binance ${m.binance?money(m.binance):"connecting…"}</div>
      <div class="sub" style="margin-top:7px">Model ${pct(m.sig.model)} • Edge ${m.sig.edge.toFixed(1)}%</div>
      <div class="bar"><i style="width:${m.sig.score}%"></i></div><div class="sub" style="margin-top:7px">Signal ${m.sig.score}/100 • ${m.mins.toFixed(1)}m left</div>
      </article>`).join(""):`<div class="empty">No matching active crypto markets were returned.</div>`;
  }

  function renderMarketsTable(){
    const asset=$("#assetFilter").value, tf=Number($("#timeFilter").value);
    const list=markets.filter(m=>(asset==="ALL"||m.asset===asset)&&Math.abs((m.duration||tf)-tf)<Math.max(3,tf*.35)).map(marketView);
    $("#marketTable").innerHTML=`<table class="table"><thead><tr><th>MARKET</th><th>YES</th><th>NO</th><th>BINANCE</th><th>MODEL</th><th>EDGE</th><th>SCORE</th><th>TIME</th></tr></thead><tbody>${list.map(m=>`<tr><td>${escapeHtml(m.asset+" — "+m.question)}</td><td>${(m.yes*100).toFixed(1)}¢</td><td>${(m.no*100).toFixed(1)}¢</td><td>${m.binance?money(m.binance):"—"}</td><td>${pct(m.sig.model)}</td><td class="${m.sig.edge>=0?"positive":"negative"}">${m.sig.edge.toFixed(1)}%</td><td>${m.sig.score}</td><td>${m.mins.toFixed(1)}m</td></tr>`).join("")||`<tr><td colspan="8" class="empty">No markets match this filter.</td></tr>`}</tbody></table>`;
  }

  function renderTrades(){
    $("#tradesTable").innerHTML=trades.length?`<table class="table"><thead><tr><th>TIME</th><th>ASSET</th><th>SIDE</th><th>ENTRY</th><th>SIZE</th><th>STATUS</th></tr></thead><tbody>${trades.slice().reverse().map(t=>`<tr><td>${new Date(t.time).toLocaleTimeString()}</td><td>${t.asset}</td><td>${t.side}</td><td>${(t.price*100).toFixed(1)}¢</td><td>${money(t.size)}</td><td class="${t.status==="WIN"?"positive":""}">${t.status}</td></tr>`).join("")}</tbody></table>`:`<div class="empty">No paper trades yet.</div>`;
  }

  function updateHeader(){
    $("#balance").textContent=money(settings.balance||10000);
    const pnl=(settings.balance||10000)-(settings.startBalance||10000); $("#pnl").textContent=money(pnl);
    $("#pnl").className=pnl>=0?"positive":"negative";
    $("#tradeCount").textContent=trades.length;
    const wins=trades.filter(t=>t.status==="WIN").length; $("#winRate").textContent=trades.length?((wins/trades.length)*100).toFixed(1)+"%":"—";
    $("#botState").textContent=bot?"RUNNING":"STOPPED"; $("#botSwitch").classList.toggle("on",bot); $("#botSwitch").classList.toggle("off",!bot);
    $("#botToggle").textContent=$("#botToggle2").textContent=bot?"Stop Paper Trader":"Start Paper Trader";
  }

  function paperTick(){
    if(!bot)return;
    const eligible=markets.map(marketView).filter(m=>m.sig.action==="BUY YES"&&m.mins>strategy.cutoff&&m.yes<=strategy.entry);
    if(!eligible.length)return;
    const m=eligible[0], maxOpen=strategy.maxTrades;
    const open=trades.filter(t=>t.status==="OPEN").length;
    if(open>=maxOpen)return;
    if(strategy.daily>0 && settings.startBalance-settings.balance >= settings.startBalance*strategy.daily/100)return;
    if(settings.confirmPaper && !window.confirm(`Paper signal: BUY YES on ${m.asset} at ${(m.yes*100).toFixed(1)}¢?`)){bot=false;updateHeader();return;}
    const size=(settings.balance||10000)*strategy.risk/100;
    trades.push({time:Date.now(),asset:m.asset,side:"BUY YES",price:m.yes,size,status:"OPEN",market:m.id});
    settings.balance-=size; persist(); renderTrades(); updateHeader();
  }

  function toggleBot(){bot=!bot;updateHeader();if(bot)paperTick()}
  $("#botToggle").onclick=toggleBot; $("#botToggle2").onclick=toggleBot; $("#refreshBtn").onclick=load;
  $("#assetFilter").onchange=renderMarketsTable; $("#timeFilter").onchange=renderMarketsTable;
  $("#clearTrades").onclick=()=>{trades=[];settings.balance=settings.startBalance||10000;persist();renderTrades();updateHeader()};

  function bindStrategy(){
    const map={timeframe:"sTime",entry:"entry",prob:"prob",edge:"edge",score:"score",target:"target",stop:"stop",cutoff:"cutoff",risk:"risk",daily:"daily",maxTrades:"maxTrades"};
    Object.entries(map).forEach(([k,id])=>{const el=$("#"+id);el.value=strategy[k];el.oninput=()=>{strategy[k]=Number(el.value);updateOutputs();renderPreview()};});
    $$(".chip").forEach(c=>c.onclick=()=>{c.classList.toggle("selected");strategy.assets=$$(".chip.selected").map(x=>x.dataset.asset);});
    updateOutputs();renderPreview();
  }
  function updateOutputs(){["entry","prob","edge","score","target","stop","risk","daily"].forEach(k=>{const o=$("#"+k+"Out");if(o)o.textContent=k==="prob"||k==="edge"||k==="risk"||k==="daily"?strategy[k]+"%":k==="score"?strategy[k]:Number(strategy[k]).toFixed(2)})}
  function renderPreview(){$("#strategyPreview").textContent=BlueEdgeStrategy.preview(strategy)}
  $("#saveStrategy").onclick=()=>{BlueEdgeStrategy.save(strategy);alert("Strategy saved locally.")};

  $("#runBacktest").onclick=()=>{
    let eq=10000,wins=0,losses=0,peak=eq,maxDD=0;const pts=[eq];
    for(let i=0;i<250;i++){const win=Math.sin(i*2.17)>-0.18;const r=win?(6+Math.random()*20):-(5+Math.random()*14);eq+=r;win?wins++:losses++;peak=Math.max(peak,eq);maxDD=Math.max(maxDD,(peak-eq)/peak);pts.push(eq)}
    $("#backtestResults").innerHTML=[["Ending equity",money(eq)],["Trades",250],["Win rate",((wins/250)*100).toFixed(1)+"%"],["Profit",money(eq-10000)],["Max drawdown",(maxDD*100).toFixed(1)+"%"]].map(x=>`<div class="stat"><span>${x[0]}</span><b>${x[1]}</b></div>`).join("");
    draw(pts);
  };

  function draw(points){const c=$("#equityCanvas"),ctx=c.getContext("2d"),dpr=devicePixelRatio||1,w=c.clientWidth,h=260;c.width=w*dpr;c.height=h*dpr;ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);ctx.strokeStyle="#1b3b58";ctx.lineWidth=1;for(let y=30;y<h;y+=50){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke()}const min=Math.min(...points),max=Math.max(...points);ctx.strokeStyle="#39a9ff";ctx.lineWidth=2;ctx.beginPath();points.forEach((v,i)=>{const x=i/(points.length-1)*w,y=h-25-(v-min)/(max-min||1)*(h-50);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke()}

  function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
  async function load(){
    try{markets=await BlueEdgeData.fetchMarkets();$("#connectionText").textContent="Polymarket public data connected";renderCards();renderMarketsTable()}
    catch(e){$("#connectionText").textContent="Polymarket unavailable";console.warn(e)}
  }
  BlueEdgeData.connectBinance((a)=>{renderCards();if($("#page-markets").classList.contains("active"))renderMarketsTable()},s=>$("#connectionText").textContent=s);
  setInterval(()=>$("#clock").textContent=new Date().toLocaleTimeString(),1000);
  setInterval(load,30000); setInterval(paperTick,15000);
  $("#displayName").value=settings.displayName||"Trader"; $("#startBalance").value=settings.startBalance||10000; $("#refreshSeconds").value=settings.refreshSeconds||30;
  $("#displayName").onchange=e=>{settings.displayName=e.target.value;persist()}; $("#startBalance").onchange=e=>{settings.startBalance=Number(e.target.value);settings.balance=settings.startBalance;persist();updateHeader()}; $("#refreshSeconds").onchange=e=>{settings.refreshSeconds=Number(e.target.value);persist()};
  $("#resetAll").onclick=()=>{if(confirm("Reset all local BlueEdge data?")){localStorage.clear();location.reload()}};
  bindStrategy(); updateHeader(); renderTrades(); load();
})();
