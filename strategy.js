window.BlueEdgeStrategy = (() => {
  const defaults={timeframe:15,assets:["BTC","ETH"],entry:.55,prob:65,edge:12,score:70,target:.72,stop:.38,cutoff:60,risk:1,daily:3,maxTrades:2};
  const key="blueedge.strategy.v1";
  const load=()=>({...defaults,...JSON.parse(localStorage.getItem(key)||"{}")});
  const save=s=>localStorage.setItem(key,JSON.stringify(s));

  function signal(asset,marketPrice,binancePrice,seed=0){
    const x=(Number.isFinite(binancePrice)?binancePrice:100000);
    const drift=((Math.sin(Date.now()/90000+seed)+1)/2)*.18-.09;
    const momentum=50+drift*100+Math.sin(x/1000+seed)*7;
    const score=Math.max(0,Math.min(100,Math.round(55+momentum*.45)));
    const model=Math.max(.05,Math.min(.95,.50+(score-50)/180));
    const edge=(model-(marketPrice||.5))*100;
    return {score,model,edge,action:(model-(marketPrice||.5)>=load().edge/100 && (marketPrice||.5)<=load().entry && score>=load().score)?"BUY YES":"WAIT"};
  }

  function preview(s){
    return `ENTRY\\n• Yes price ≤ ${Number(s.entry).toFixed(2)}\\n• Model probability ≥ ${s.prob}%\\n• Edge ≥ ${s.edge}%\\n• Signal score ≥ ${s.score}\\n• ${s.cutoff}s minimum time remaining\\n\\nEXIT\\n• Target ≥ ${Number(s.target).toFixed(2)}\\n• Stop ≤ ${Number(s.stop).toFixed(2)}\\n\\nRISK\\n• ${s.risk}% of paper equity / trade\\n• Daily loss cap ${s.daily}%\\n• Max ${s.maxTrades} open trades`;
  }
  return {defaults,load,save,signal,preview};
})();
