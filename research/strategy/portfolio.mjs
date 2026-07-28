#!/usr/bin/env node
/**
 * Multi-asset trend portfolio (CTA-style, long/flat, no leverage) — the recommended
 * strategy. Per asset: a 4-vote trend ensemble sets an inverse-vol (risk-parity)
 * sleeve, capped per name; gross capped at 1 (cash when few assets trend). Two
 * portfolio-level de-risk overlays do the heavy lifting on drawdown:
 *   BTC-beta GATE — scale the whole book by BTC's own trend vote (exit when the
 *                   market leader rolls over; crypto crashes are systemic).
 *   VOL CAP       — scale by min(1, VOL_CAP / trailing-30d realized portfolio vol).
 * Costs charged on turnover. Reports CAGR/MaxDD/Sharpe/Sortino/Calmar, monthly &
 * daily profit factor, monthly & yearly win rate.
 *
 *   node portfolio.mjs <dir-of-Date,Close-csvs> [from] [to]
 * Env: SIG_TGT(0.20 per-sleeve vol) CAP(0.35 max/name) REBAL(5 days) COST(0.001)
 *      VOL_CAP(0.40 portfolio vol target; 0=off — it's the risk dial) BTC_GATE(1).
 *
 * Data: a directory of `<asset>.csv` files, each `Date,Close` daily (a `btc.csv`
 * must be present for the BTC gate). Get them from CoinMetrics community data:
 *   raw.githubusercontent.com/coinmetrics/data/master/csv/<asset>.csv (PriceUSD col)
 * Verdict (2020+, 13 assets): +52% CAGR, -40% MaxDD, Sharpe 1.29, Calmar 1.30,
 * monthly PF 3.07 — beats the single-asset flagship on every axis; cost- & param-robust.
 */
import fs from "fs";
const DIR = process.argv[2] || "uni";
const COST   = +(process.env.COST   ?? 0.0010);
const SIG_TGT= +(process.env.SIG_TGT?? 0.20);   // per-sleeve annualized vol target
const CAP    = +(process.env.CAP    ?? 0.35);   // max weight per asset
const REBAL  = +(process.env.REBAL  ?? 5);      // rebalance every N days
const VOL_CAP= +(process.env.VOL_CAP?? 0.40);   // portfolio realized-vol target (0=off)
const BTC_GATE=(process.env.BTC_GATE ?? "1")!=="0"; // scale whole book by BTC trend vote
const FROM   = process.argv[3] || "2014-01-01";
const TO     = process.argv[4] || "2026-12-31";
const YR=365;

const files = fs.readdirSync(DIR).filter(f=>f.endsWith(".csv"));
const SMA=(a,n)=>a.map((_,i)=>i<n-1?NaN:a.slice(i-n+1,i+1).reduce((s,x)=>s+x,0)/n);
const rMax=(a,n)=>a.map((_,i)=>i<n-1?NaN:Math.max(...a.slice(i-n+1,i+1)));
const rMin=(a,n)=>a.map((_,i)=>i<n-1?NaN:Math.min(...a.slice(i-n+1,i+1)));
const rStd=(a,n)=>a.map((_,i)=>{if(i<n)return NaN;const w=a.slice(i-n+1,i+1);const m=w.reduce((s,x)=>s+x,0)/n;return Math.sqrt(w.reduce((s,x)=>s+(x-m)**2,0)/n);});

// load + per-asset signals, keyed by date
const assets = files.map(f=>{
  const rows=fs.readFileSync(`${DIR}/${f}`,"utf8").trim().split("\n").slice(1).map(l=>{const [d,c]=l.split(",");return {d,c:+c};}).filter(r=>r.c>0);
  rows.sort((a,b)=>a.d<b.d?-1:1);
  const date=rows.map(r=>r.d), close=rows.map(r=>r.c);
  const ret=close.map((c,i)=>i?c/close[i-1]-1:0);
  const s200=SMA(close,200),f20=SMA(close,20),s100=SMA(close,100),hi=rMax(close,50),lo=rMin(close,25),sd=rStd(ret,30);
  const don=new Array(close.length).fill(0);
  for(let i=1;i<close.length;i++){ if(!isNaN(hi[i])&&close[i]>=hi[i-1])don[i]=1; else if(!isNaN(lo[i])&&close[i]<=lo[i-1])don[i]=0; else don[i]=don[i-1]; }
  const sig=new Map();
  for(let i=0;i<close.length;i++){
    if(i<200||isNaN(sd[i]))continue;
    const vote=((close[i]>s200[i])+(f20[i]>s100[i])+don[i]+(close[i]>close[i-100]))/4;
    const vol=sd[i]*Math.sqrt(YR);
    sig.set(date[i],{vote,vol});
  }
  const retNext=new Map(); for(let i=0;i<date.length-1;i++) retNext.set(date[i],ret[i+1]);
  return {name:f.replace(".csv",""), sig, retNext};
});

// master date axis
const allDates=[...new Set(assets.flatMap(a=>[...a.sig.keys()]))].filter(d=>d>=FROM&&d<=TO).sort();

const BTC=assets.find(a=>a.name==="btc");
const std=a=>{const m=a.reduce((s,x)=>s+x,0)/a.length;return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/a.length);};
// daily loop
let wPrev={}; const R=[]; const dates=[]; let held=[];
for(let k=0;k<allDates.length;k++){ const d=allDates[k];
  // (re)compute target weights every REBAL days
  let w=wPrev;
  if(k%REBAL===0){
    w={}; const sleeves=[];
    for(const a of assets){ const s=a.sig.get(d); if(!s||s.vote<=0||!(s.vol>0))continue;
      const sleeve=s.vote*Math.max(0,Math.min(CAP, SIG_TGT/s.vol)); if(sleeve>0)sleeves.push([a.name,sleeve]); }
    let gross=sleeves.reduce((s,x)=>s+x[1],0); let scale=gross>1?1/gross:1;
    // portfolio realized-vol cap (time-series de-risk; reacts fast in crashes)
    if(VOL_CAP>0 && R.length>=30){ const rv=std(R.slice(-30))*Math.sqrt(YR); if(rv>0) scale*=Math.min(1,VOL_CAP/rv); }
    // BTC market-beta gate: scale the whole book by BTC's own trend vote
    if(BTC_GATE){ const bs=BTC?.sig.get(d); scale*=(bs? bs.vote : 0); }
    for(const [n,s] of sleeves) w[n]=s*scale;
  }
  // portfolio next-day return + turnover cost
  let ret=0; for(const a of assets){ const wi=w[a.name]||0; if(wi){ const rn=a.retNext.get(d); if(rn!=null) ret+=wi*rn; } }
  let turn=0; const names=new Set([...Object.keys(w),...Object.keys(wPrev)]);
  for(const n of names) turn+=Math.abs((w[n]||0)-(wPrev[n]||0));
  ret-=turn*COST;
  R.push(ret); dates.push(d); wPrev=w;
  if(k===allDates.length-1) held=Object.entries(w).filter(([,x])=>x>0.01).sort((a,b)=>b[1]-a[1]);
}

// metrics
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const sd=a=>{const m=mean(a);return Math.sqrt(mean(a.map(x=>(x-m)**2)));};
function report(label,r,ds){
  let eq=1,pk=1,mdd=0; for(const x of r){eq*=1+x;pk=Math.max(pk,eq);mdd=Math.min(mdd,eq/pk-1);}
  const yrs=r.length/YR,cagr=eq**(1/yrs)-1, sh=sd(r)?mean(r)/sd(r)*Math.sqrt(YR):0;
  const neg=r.filter(x=>x<0), so=neg.length?mean(r)/sd(neg)*Math.sqrt(YR):0;
  // monthly returns for PF + win rate
  const mo=new Map(); for(let i=0;i<ds.length;i++){const mk=ds[i].slice(0,7);mo.set(mk,(mo.get(mk)||1)*(1+r[i]));}
  const moR=[...mo.values()].map(x=>x-1);
  const pfM=moR.filter(x=>x>0).reduce((s,x)=>s+x,0)/Math.abs(moR.filter(x=>x<0).reduce((s,x)=>s+x,0)||1e-9);
  const pfD=r.filter(x=>x>0).reduce((s,x)=>s+x,0)/Math.abs(r.filter(x=>x<0).reduce((s,x)=>s+x,0)||1e-9);
  const yr=new Map(); for(let i=0;i<ds.length;i++){const y=ds[i].slice(0,4);yr.set(y,(yr.get(y)||1)*(1+r[i]));}
  const yrR=[...yr.values()].map(x=>x-1);
  console.log(`${label.padEnd(22)} CAGR ${p(cagr)} MaxDD ${p(mdd)} Sharpe ${sh.toFixed(2)} Sortino ${so.toFixed(2)} Calmar ${(mdd?cagr/Math.abs(mdd):0).toFixed(2)} PF(mo) ${pfM.toFixed(2)} PF(d) ${pfD.toFixed(2)} win mo/yr ${(moR.filter(x=>x>0).length/moR.length*100).toFixed(0)}/${(yrR.filter(x=>x>0).length/yrR.length*100).toFixed(0)}%`);
  return {cagr,mdd,sh,yr:[...yr.entries()]};
}
function p(x){return ((x*100>=0?"+":"")+(x*100).toFixed(0)+"%").padStart(6);}

console.log(`\n=== MULTI-ASSET TREND PORTFOLIO (${assets.length} assets, rebal ${REBAL}d, cost ${(COST*1e4).toFixed(0)}bp, per-sleeve vol ${(SIG_TGT*100).toFixed(0)}%, cap ${(CAP*100).toFixed(0)}%) ===`);
console.log(`   ${FROM} -> ${allDates[allDates.length-1]}  (${allDates.length} days)\n`);
const m=report("Portfolio", R, dates);
console.log(`\n   currently held: ${held.map(([n,w])=>`${n} ${(w*100).toFixed(0)}%`).join(", ")||"(cash)"}`);
console.log(`   yearly: ${m.yr.map(([y,e])=>`${y} ${p(e-1)}`).join("  ")}`);
