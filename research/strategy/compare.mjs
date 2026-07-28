#!/usr/bin/env node
/**
 * Flagship deep-dive: the recommended strategy run single-asset vs a 50/50
 * two-asset portfolio (diversification lowers drawdown), with monthly/yearly win
 * rates, and exports curves.json for the visual report.
 *
 *   node compare.mjs [asset1 Date,Close csv] [asset2 csv]   (defaults btc-cm.csv eth-cm.csv)
 */
import fs from "fs";
import { load, STRATS, run } from "./backtest.mjs";
const FLAG = "Ensemble+VolCap";
const A1 = process.argv[2] || "btc-cm.csv";
const A2 = process.argv[3] || "eth-cm.csv";
const YR=365;
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const sd=a=>{const m=mean(a);return Math.sqrt(mean(a.map(x=>(x-m)**2)));};

function metrics(dates, r){ // r aligned to dates (r[0]=0)
  let eq=1,peak=1,mdd=0; const curve=[];
  for(let i=0;i<r.length;i++){ eq*=1+r[i]; curve.push(eq); peak=Math.max(peak,eq); mdd=Math.min(mdd,eq/peak-1); }
  const yrs=r.length/YR, cagr=Math.pow(eq,1/yrs)-1;
  const sharpe=sd(r)?mean(r)/sd(r)*Math.sqrt(YR):0;
  const neg=r.filter(x=>x<0); const sortino=neg.length?mean(r)/sd(neg)*Math.sqrt(YR):0;
  // monthly & yearly
  const mo=new Map(), yr=new Map();
  for(let i=0;i<dates.length;i++){ const mk=dates[i].slice(0,7), yk=dates[i].slice(0,4);
    mo.set(mk,(mo.get(mk)||1)*(1+r[i])); yr.set(yk,(yr.get(yk)||1)*(1+r[i])); }
  const moR=[...mo.values()].map(x=>x-1), yrR=[...yr.values()].map(x=>x-1);
  return { eq, cagr, mdd, sharpe, sortino, calmar:mdd?cagr/Math.abs(mdd):0,
    winDay:r.filter(x=>x>0).length/r.length, winMon:moR.filter(x=>x>0).length/moR.length,
    winYr:yrR.filter(x=>x>0).length/yrR.length, curve, yr:[...yr.entries()] };
}
function stratReturns(D){ const e=STRATS[FLAG](D); const m=run(D,e); return m.r; } // daily net returns

const btc=load(A1), eth=load(A2);
// align on common dates (intersection) for the portfolio
const ei=new Map(eth.date.map((d,i)=>[d,i]));
const common=btc.date.map((d,i)=>({d,bi:i,ei:ei.has(d)?ei.get(d):-1})).filter(x=>x.ei>=0);
const bR=stratReturns(btc), eR=stratReturns(eth);
const pDates=common.map(x=>x.d);
const pRet=common.map(x=>0.5*bR[x.bi]+0.5*eR[x.ei]); // 50/50 daily-rebalanced

const P=(x)=>((x*100>=0?"+":"")+(x*100).toFixed(0)+"%");
const row=(name,m)=>console.log(`${name.padEnd(24)} CAGR ${P(m.cagr).padStart(6)}  MaxDD ${P(m.mdd).padStart(5)}  Sharpe ${m.sharpe.toFixed(2)}  Calmar ${m.calmar.toFixed(2)}  win d/m/y ${(m.winDay*100).toFixed(0)}/${(m.winMon*100).toFixed(0)}/${(m.winYr*100).toFixed(0)}%`);

console.log(`\n=== FLAGSHIP "${FLAG}" — single asset vs 50/50 BTC+ETH portfolio (cost 10bp, volTgt cap 65%) ===\n`);
const mB=metrics(btc.date, bR); row("BTC only", mB);
const mE=metrics(eth.date, eR); row("ETH only", mE);
const mP=metrics(pDates, pRet); row("50/50 BTC+ETH portfolio", mP);
// benchmark: buy&hold BTC
const mBH=metrics(btc.date, run(btc,STRATS["Buy & Hold"](btc)).r); row("(bench) Buy&Hold BTC", mBH);

console.log(`\n=== Portfolio yearly returns ===`);
console.log(mP.yr.map(([y,e])=>`${y}: ${P(e-1)}`).join("   "));

// export curves for the visual (downsample to ~ weekly)
const out={ flagship:FLAG, dates:pDates.filter((_,i)=>i%7===0),
  portfolio:mP.curve.filter((_,i)=>i%7===0),
  btc_dates:btc.date.filter((_,i)=>i%7===0),
  btc_flag:mB.curve.filter((_,i)=>i%7===0),
  btc_bh:mBH.curve.filter((_,i)=>i%7===0),
  metrics:{ btc:pick(mB), eth:pick(mE), port:pick(mP), bh:pick(mBH) } };
function pick(m){return {cagr:m.cagr,mdd:m.mdd,sharpe:m.sharpe,calmar:m.calmar,winDay:m.winDay,winMon:m.winMon,winYr:m.winYr};}
fs.writeFileSync("curves.json", JSON.stringify(out));
console.log("\n[curves.json written]");
