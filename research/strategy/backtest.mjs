#!/usr/bin/env node
/**
 * Daily long/flat crypto backtest engine + trend-strategy library.
 * ---------------------------------------------------------------
 * Causal (signal at close_t sets exposure e_t applied to the NEXT day's return),
 * costs charged on |Δe| (turnover). Long/flat only — no shorting, no leverage
 * (max exposure 1.0). Reports CAGR, MaxDD, Sharpe, Sortino, Calmar, daily win%,
 * avg exposure, trade count.
 *
 *   node backtest.mjs <Date,Close csv> [from YYYY-MM-DD] [to]
 *   COST=0.001 TVOL=0.50 node backtest.mjs btc.csv 2010-01-01 2019-12-31
 *
 * Input: a two-column CSV `Date,Close` (daily). Get one from CoinMetrics
 * community data (raw.githubusercontent.com/coinmetrics/data/master/csv/<asset>.csv,
 * PriceUSD column), by aggregating minute data, or `fetch-hourly.js SYMBOL 1d`.
 * The strategy library is exported for compare.mjs. Verdict: trend-following
 * (esp. the ensemble + mild vol cap) beats buy&hold on Sharpe/Calmar and roughly
 * halves drawdown, robust across BTC train/test and ETH. Env: COST (per unit
 * turnover, def 0.001), TVOL (annualized vol target, def 0.50).
 */
import fs from "fs";
const COST = +(process.env.COST ?? 0.0010);   // per unit exposure change (10 bps)
const TVOL = +(process.env.TVOL ?? 0.50);      // annualized vol target
const YR = 365;

export function load(path, from, to){
  const rows = fs.readFileSync(path,"utf8").trim().split("\n").slice(1)
    .map(l=>{const [d,c]=l.split(",");return {d, c:+c};})
    .filter(r=>r.c>0 && (!from||r.d>=from) && (!to||r.d<=to));
  rows.sort((a,b)=>a.d<b.d?-1:1);
  const date=rows.map(r=>r.d), close=rows.map(r=>r.c);
  const ret=close.map((c,i)=>i? c/close[i-1]-1 : 0);
  return {date, close, ret, n:close.length};
}
// ---- indicators (causal: value at i uses closes <= i) ----
const SMA=(a,n)=>a.map((_,i)=>i<n-1?NaN:a.slice(i-n+1,i+1).reduce((s,x)=>s+x,0)/n);
const rollStd=(a,n)=>a.map((_,i)=>{if(i<n)return NaN;const w=a.slice(i-n+1,i+1);const m=w.reduce((s,x)=>s+x,0)/n;return Math.sqrt(w.reduce((s,x)=>s+(x-m)**2,0)/n);});
const rollMax=(a,n)=>a.map((_,i)=>i<n-1?NaN:Math.max(...a.slice(i-n+1,i+1)));
const rollMin=(a,n)=>a.map((_,i)=>i<n-1?NaN:Math.min(...a.slice(i-n+1,i+1)));

// ---- strategy library: each returns target exposure e[i] in [0,1], using data <= i ----
export const STRATS = {
  "Buy & Hold": D => D.close.map(()=>1),

  "SMA200 regime": D => { const s=SMA(D.close,200); return D.close.map((c,i)=>isNaN(s[i])?0:(c>s[i]?1:0)); },

  "MA cross 20/100": D => { const f=SMA(D.close,20),s=SMA(D.close,100);
    return D.close.map((_,i)=>(isNaN(s[i])?0:(f[i]>s[i]?1:0))); },

  "Donchian 50/25": D => { const hi=rollMax(D.close,50),lo=rollMin(D.close,25); const e=new Array(D.n).fill(0);
    for(let i=1;i<D.n;i++){ if(!isNaN(hi[i])&&D.close[i]>=hi[i-1]) e[i]=1; else if(!isNaN(lo[i])&&D.close[i]<=lo[i-1]) e[i]=0; else e[i]=e[i-1]; }
    return e; },

  "TSMOM 100d": D => { return D.close.map((c,i)=> i<100?0:(c>D.close[i-100]?1:0)); },

  "VolTarget only": D => { const sd=rollStd(D.ret,30); return D.ret.map((_,i)=>isNaN(sd[i])?0:clip(TVOL/(sd[i]*Math.sqrt(YR)),0,1)); },

  "Regime+VolTarget": D => { const s=SMA(D.close,200),sd=rollStd(D.ret,30);
    return D.close.map((c,i)=>(isNaN(s[i])||isNaN(sd[i]))?0:(c>s[i]?clip(TVOL/(sd[i]*Math.sqrt(YR)),0,1):0)); },

  // in-uptrend, add exposure on short-term dips (buy the dip); vol-scaled; regime-gated
  "Regime+VolTgt+Dip": D => { const s=SMA(D.close,200),sd=rollStd(D.ret,30),s10=SMA(D.close,10);
    return D.close.map((c,i)=>{ if(isNaN(s[i])||isNaN(sd[i])||isNaN(s10[i])) return 0; if(c<=s[i]) return 0;
      const base=clip(TVOL/(sd[i]*Math.sqrt(YR)),0,1);
      const dip = c < s10[i] ? 1.15 : 1.0;             // 15% add when below 10d MA (pullback) in uptrend
      return clip(base*dip,0,1); }); },

  // ENSEMBLE: average of 4 standard trend signals -> smoother entries/exits
  "Trend Ensemble": D => ensemble(D),

  // ensemble gated by a MILD vol cap (only deleverages in high vol; target 65%)
  "Ensemble+VolCap": D => { const e=ensemble(D), sd=rollStd(D.ret,30);
    return e.map((x,i)=> isNaN(sd[i])? 0 : x*clip(0.65/(sd[i]*Math.sqrt(YR)),0,1)); },
};

// average of SMA200, MA20/100, Donchian50/25, TSMOM100 (each 0/1) -> exposure in [0,1]
function ensemble(D){
  const s=SMA(D.close,200), f=SMA(D.close,20), s2=SMA(D.close,100), hi=rollMax(D.close,50), lo=rollMin(D.close,25);
  const don=new Array(D.n).fill(0);
  for(let i=1;i<D.n;i++){ if(!isNaN(hi[i])&&D.close[i]>=hi[i-1]) don[i]=1; else if(!isNaN(lo[i])&&D.close[i]<=lo[i-1]) don[i]=0; else don[i]=don[i-1]; }
  return D.close.map((c,i)=>{ if(i<200) return 0;
    const a=c>s[i]?1:0, b=(f[i]>s2[i])?1:0, cc=don[i], e=(c>D.close[i-100])?1:0;
    return (a+b+cc+e)/4; });
}
function clip(x,a,b){return Math.max(a,Math.min(b,x));}

// ---- runner: apply exposure to next-day return, charge costs, compute metrics ----
export function run(D, expo){
  const r=new Array(D.n).fill(0); let ePrev=0;
  for(let i=0;i<D.n-1;i++){ const e=isNaN(expo[i])?0:expo[i];
    const gross=e*D.ret[i+1]; const cost=Math.abs(e-ePrev)*COST; r[i+1]=gross-cost; ePrev=e; }
  // equity + metrics
  let eq=1,peak=1,mdd=0; const curve=[1];
  for(let i=1;i<D.n;i++){ eq*=1+r[i]; curve.push(eq); peak=Math.max(peak,eq); mdd=Math.min(mdd,eq/peak-1); }
  const yrs=D.n/YR, cagr=Math.pow(eq,1/yrs)-1;
  const inMkt=r.map((x,i)=>expo[i-1]>0.001); // days holding
  const active=r.filter((_,i)=>expo[i-1]>0.001);
  const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
  const sd=a=>{const m=mean(a);return Math.sqrt(mean(a.map(x=>(x-m)**2)));};
  const dailyMean=mean(r.slice(1)), dailySd=sd(r.slice(1));
  const sharpe=dailySd?dailyMean/dailySd*Math.sqrt(YR):0;
  const neg=r.slice(1).filter(x=>x<0); const sortino=neg.length?dailyMean/sd(neg)*Math.sqrt(YR):0;
  const winDays=active.filter(x=>x>0).length/(active.length||1);
  const expoAvg=mean(expo.map(x=>isNaN(x)?0:x));
  // count trades (exposure crossing above ~0)
  let trades=0; for(let i=1;i<D.n;i++){ if((expo[i]>0.001)&&!(expo[i-1]>0.001)) trades++; }
  return { cagr, mdd, sharpe, sortino, calmar: mdd?cagr/Math.abs(mdd):0, winDays, expoAvg, trades, eq, curve, r };
}

// ---- CLI: node backtest.mjs <csv> [from] [to] ----
if(import.meta.url===`file://${process.argv[1]}`){
  const [,,path,from,to]=process.argv; const D=load(path,from,to);
  console.log(`\n${path.split("/").pop()}  ${D.date[0]}→${D.date[D.n-1]}  (${D.n} days)  cost=${(COST*1e4).toFixed(0)}bp volTgt=${(TVOL*100).toFixed(0)}%`);
  console.log("strategy            CAGR    MaxDD   Sharpe  Sortino Calmar  Win%   Expo  Trades");
  for(const [name,fn] of Object.entries(STRATS)){ const m=run(D,fn(D));
    console.log(`${name.padEnd(19)} ${p(m.cagr)} ${p(m.mdd)}  ${m.sharpe.toFixed(2).padStart(5)}  ${m.sortino.toFixed(2).padStart(5)}  ${m.calmar.toFixed(2).padStart(5)}  ${(m.winDays*100).toFixed(0).padStart(3)}%  ${(m.expoAvg*100).toFixed(0).padStart(3)}%  ${String(m.trades).padStart(4)}`);
  }
}
function p(x){return ((x*100>=0?"+":"")+(x*100).toFixed(0)+"%").padStart(6);}
