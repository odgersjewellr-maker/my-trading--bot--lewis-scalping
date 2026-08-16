// Tests a scale-out exit (bank most of the position at a small profit target,
// let a small runner ride the trailing stop) against pure-trail, on 8 years of
// real daily BTC data, using the same NKB signal math as bot.js/backtest.js.
// Goal: find out how high a win rate is actually reachable, and what it costs
// in total return — this is what SCALE_OUT_* in bot.js's CONFIG is based on.
// Usage: node backtest-scaleout.mjs [csv-path]
import { readFileSync } from "fs";
import { resolve } from "path";
const csvPath = process.argv[2] || "btc-daily-binance.csv";
const lines = readFileSync(resolve(csvPath), "utf8").trim().split("\n").slice(1);
const candles = lines.map((l) => { const [date,o,h,l2,c,v]=l.split(","); return {date:date.trim(),open:+o,high:+h,low:+l2,close:+c,volume:+v}; }).filter(c=>!isNaN(c.close));

function calcATRSeries(candles, period) {
  const n=candles.length, tr=new Array(n).fill(null);
  for (let i=1;i<n;i++){const c=candles[i],p=candles[i-1];tr[i]=Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close));}
  const atr=new Array(n).fill(null); if(n<=period) return atr;
  let sum=0; for(let i=1;i<=period;i++) sum+=tr[i]; atr[period]=sum/period;
  for(let i=period+1;i<n;i++) atr[i]=(atr[i-1]*(period-1)+tr[i])/period;
  return atr;
}
function calcEMASeries(values, period) {
  const k=2/(period+1); const out=new Array(values.length).fill(null); let ema=null;
  for(let i=0;i<values.length;i++){const v=values[i]; if(v==null) continue; ema=ema==null?v:v*k+ema*(1-k); out[i]=ema;}
  return out;
}
function calcStddevSeries(values, period) {
  const out=new Array(values.length).fill(null);
  for(let i=period-1;i<values.length;i++){const w=values.slice(i-period+1,i+1).map(v=>v??0);const m=w.reduce((a,b)=>a+b,0)/period;out[i]=Math.sqrt(w.reduce((s,v)=>s+(v-m)**2,0)/period);}
  return out;
}
function calcNKBSeries(candles, cfg) {
  const closes=candles.map(c=>c.close); const n=closes.length;
  const atrArr=calcATRSeries(candles,cfg.atrLen);
  const atrNorm=atrArr.map((a,i)=>a!=null?a/closes[i]:null);
  const atrFactor=calcEMASeries(atrNorm,cfg.atrLen);
  const h=atrFactor.map(f=>cfg.bandwidth*(1+(f??0)*200));
  const nwRaw=new Array(n);
  for(let i=0;i<n;i++){const hi=h[i];let sumW=0,sumWC=0;const lb=Math.min(cfg.length,i+1);
    for(let j=0;j<lb;j++){const kw=Math.exp(-(j*j)/(2*hi*hi));sumWC+=kw*closes[i-j];sumW+=kw;}
    nwRaw[i]=sumW>0?sumWC/sumW:closes[i];}
  const kernelArr=calcEMASeries(nwRaw,cfg.smooth);
  const residuals=closes.map((c,i)=>kernelArr[i]!=null?c-kernelArr[i]:null);
  const sigmaRaw=calcStddevSeries(residuals,cfg.bandLen);
  const sigmaArr=calcEMASeries(sigmaRaw,cfg.bandSmooth);
  const upper=new Array(n).fill(null), lower=new Array(n).fill(null);
  for(let i=0;i<n;i++){if(kernelArr[i]==null||sigmaArr[i]==null) continue; upper[i]=kernelArr[i]+cfg.bandMult*sigmaArr[i]; lower[i]=kernelArr[i]-cfg.bandMult*sigmaArr[i];}
  const state=new Array(n).fill(0); let lastState=0;
  for(let i=0;i<n;i++){if(upper[i]==null){state[i]=lastState;continue;} if(closes[i]>upper[i]) lastState=1; else if(closes[i]<lower[i]) lastState=-1; state[i]=lastState;}
  return {state, atrArr};
}
const NKB_CFG = { length:30, bandwidth:6.0, atrLen:14, smooth:3, bandMult:3.0, bandLen:24, bandSmooth:5 };

function calcADXSeries(candles, period=14) {
  const n=candles.length, plusDM=new Array(n).fill(null), minusDM=new Array(n).fill(null), tr=new Array(n).fill(null);
  for(let i=1;i<n;i++){const c=candles[i],p=candles[i-1];tr[i]=Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close));const up=c.high-p.high,dn=p.low-c.low;plusDM[i]=(up>dn&&up>0)?up:0;minusDM[i]=(dn>up&&dn>0)?dn:0;}
  const smTR=new Array(n).fill(null),smPlus=new Array(n).fill(null),smMinus=new Array(n).fill(null);
  let iTR=0,iP=0,iM=0; for(let i=1;i<=period;i++){iTR+=tr[i];iP+=plusDM[i];iM+=minusDM[i];}
  smTR[period]=iTR;smPlus[period]=iP;smMinus[period]=iM;
  for(let i=period+1;i<n;i++){smTR[i]=smTR[i-1]-smTR[i-1]/period+tr[i];smPlus[i]=smPlus[i-1]-smPlus[i-1]/period+plusDM[i];smMinus[i]=smMinus[i-1]-smMinus[i-1]/period+minusDM[i];}
  const dx=new Array(n).fill(null);
  for(let i=period;i<n;i++){if(!smTR[i]) continue; const pdi=100*smPlus[i]/smTR[i],mdi=100*smMinus[i]/smTR[i];const s=pdi+mdi;dx[i]=s>0?100*Math.abs(pdi-mdi)/s:0;}
  const adx=new Array(n).fill(null); const start=period*2; if(start>=n) return adx;
  let sumDX=0; for(let i=period;i<start;i++) sumDX+=dx[i]??0; adx[start-1]=sumDX/period;
  for(let i=start;i<n;i++) adx[i]=(adx[i-1]*(period-1)+(dx[i]??0))/period;
  return adx;
}

// scaleOut: null = pure trail (current live behavior). Otherwise { bankFrac, tpMult }
function runBacktest(candles, { atrStopMult, riskPct, confirmBars, scaleOut, trailMult=3.0, adxEntryMin=0, regimeGate=false }) {
  const { state, atrArr } = calcNKBSeries(candles, NKB_CFG);
  const adxArr = calcADXSeries(candles, 14);
  const n = candles.length;
  let portfolio=1000, position=null, prevState=0, pendingSignal=null, pendingBars=0;
  const closedTrades = [], equity=[portfolio];

  for (let i=1;i<n;i++) {
    const c = candles[i];
    const price = c.close, curState = state[i], atr = atrArr[i], date = c.date;
    const flippedBull = curState===1 && prevState!==1, flippedBear = curState===-1 && prevState!==-1;
    if (flippedBull) { pendingSignal="BUY"; pendingBars=1; }
    else if (flippedBear) { pendingSignal="SELL"; pendingBars=1; }
    else if (curState===prevState) pendingBars++;
    else { pendingSignal=null; pendingBars=0; }
    prevState = curState;
    const buySignal = pendingSignal==="BUY" && pendingBars>=confirmBars;
    const sellSignal = pendingSignal==="SELL" && pendingBars>=confirmBars;

    if (position) {
      // Check partial TP first (using the bar's high/low, not just close -- more realistic)
      if (scaleOut && !position.partialTaken) {
        const tpPrice = position.side==="long" ? position.entry + scaleOut.tpMult*position.stopDist : position.entry - scaleOut.tpMult*position.stopDist;
        const tpHit = position.side==="long" ? c.high >= tpPrice : c.low <= tpPrice;
        if (tpHit) {
          const bankQty = position.qty * scaleOut.bankFrac;
          const pnl = position.side==="long" ? (tpPrice-position.entry)*bankQty : (position.entry-tpPrice)*bankQty;
          portfolio += pnl;
          position.realizedPnl = (position.realizedPnl||0) + pnl;
          position.qty -= bankQty;
          position.partialTaken = true;
          // lock the runner's stop to breakeven so it can't turn a banked win into a loss
          position.stop = position.side==="long" ? Math.max(position.stop, position.entry) : Math.min(position.stop, position.entry);
        }
      }
      // Trailing stop ratchet (matches bot.js: 3x ATR, only tightens)
      if (atr) {
        const trailDist = atr*trailMult;
        if (position.side==="long") { const ns = price - trailDist; if (ns > position.stop) position.stop = ns; }
        else { const ns = price + trailDist; if (ns < position.stop) position.stop = ns; }
      }
      // Stop check (using bar low/high)
      const stopHit = position.side==="long" ? c.low <= position.stop : c.high >= position.stop;
      if (stopHit) {
        const exitPrice = position.stop;
        const pnl = position.side==="long" ? (exitPrice-position.entry)*position.qty : (position.entry-exitPrice)*position.qty;
        portfolio += pnl;
        const totalPnl = (position.realizedPnl||0) + pnl;
        closedTrades.push({ date, side: position.side, totalPnl, hoursHeld: (i-position.openIdx)*24 });
        position = null;
      }
    }
    if (position && ((position.side==="long" && sellSignal) || (position.side==="short" && buySignal))) {
      const pnl = position.side==="long" ? (price-position.entry)*position.qty : (position.entry-price)*position.qty;
      portfolio += pnl;
      const totalPnl = (position.realizedPnl||0) + pnl;
      closedTrades.push({ date, side: position.side, totalPnl, hoursHeld: (i-position.openIdx)*24 });
      position = null;
    }
    if (!position && (buySignal || sellSignal)) {
      const adxVal = adxArr[i];
      const adxOk = adxEntryMin <= 0 || (adxVal != null && adxVal >= adxEntryMin);
      let regimeOk = true;
      if (regimeGate && i >= 21) { const ret20 = candles[i-1].close/candles[i-21].close - 1; regimeOk = Math.abs(ret20) > 0.05; }
      if (adxOk && regimeOk) {
        const side = buySignal ? "long" : "short";
        const stopDist = atr ? atr*atrStopMult : price*0.02;
        const riskAmount = portfolio*riskPct;
        const qty = Math.min(riskAmount/stopDist, portfolio/price);
        const stop = side==="long" ? price-stopDist : price+stopDist;
        position = { side, entry: price, qty, stop, stopDist, openIdx: i, partialTaken:false, realizedPnl:0 };
      }
    }
    equity.push(portfolio + (position ? (position.side==="long"?(price-position.entry)*position.qty:(position.entry-price)*position.qty) : 0));
  }
  if (position) {
    const price = candles[n-1].close;
    const pnl = position.side==="long" ? (price-position.entry)*position.qty : (position.entry-price)*position.qty;
    portfolio += pnl;
    closedTrades.push({ date: candles[n-1].date, side: position.side, totalPnl: (position.realizedPnl||0)+pnl, hoursHeld: (n-1-position.openIdx)*24 });
  }

  const wins = closedTrades.filter(t=>t.totalPnl>0), losses = closedTrades.filter(t=>t.totalPnl<=0);
  const winRate = closedTrades.length ? wins.length/closedTrades.length*100 : 0;
  const grossWin = wins.reduce((s,t)=>s+t.totalPnl,0), grossLoss = Math.abs(losses.reduce((s,t)=>s+t.totalPnl,0));
  const pf = grossLoss>0 ? grossWin/grossLoss : Infinity;
  let peak=equity[0], maxDD=0;
  for (const v of equity) { if (v>peak) peak=v; const dd=(peak-v)/peak*100; if (dd>maxDD) maxDD=dd; }
  const years = (new Date(candles[n-1].date)-new Date(candles[0].date))/(365.25*86400000);
  const cagr = (Math.pow(portfolio/1000,1/years)-1)*100;
  return { finalPortfolio: portfolio, trades: closedTrades.length, winRate, pf, maxDD, cagr, totalReturn: (portfolio/1000-1)*100, years };
}

const variants = {
  "Pure trail (current live design)":     { atrStopMult:1.0, riskPct:0.05, confirmBars:2, scaleOut:null },
  "Bank 50% @1R, run rest":               { atrStopMult:1.0, riskPct:0.05, confirmBars:2, scaleOut:{bankFrac:0.5, tpMult:1.0} },
  "Bank 70% @1R, run rest":               { atrStopMult:1.0, riskPct:0.05, confirmBars:2, scaleOut:{bankFrac:0.7, tpMult:1.0} },
  "Bank 70% @0.5R, run rest":             { atrStopMult:1.0, riskPct:0.05, confirmBars:2, scaleOut:{bankFrac:0.7, tpMult:0.5} },
  "Bank 85% @0.5R, run rest":             { atrStopMult:1.0, riskPct:0.05, confirmBars:2, scaleOut:{bankFrac:0.85, tpMult:0.5} },
  "Bank 90% @0.3R, run rest":             { atrStopMult:1.0, riskPct:0.05, confirmBars:2, scaleOut:{bankFrac:0.9, tpMult:0.3} },
  "Bank70@1R + ADX25 gate":               { atrStopMult:1.0, riskPct:0.05, confirmBars:2, scaleOut:{bankFrac:0.7, tpMult:1.0}, adxEntryMin:25 },
  "Bank70@1R + ADX25 + regime":           { atrStopMult:1.0, riskPct:0.05, confirmBars:2, scaleOut:{bankFrac:0.7, tpMult:1.0}, adxEntryMin:25, regimeGate:true },
  "Bank70@1R + wider stop 1.75x":         { atrStopMult:1.75, riskPct:0.05, confirmBars:2, scaleOut:{bankFrac:0.7, tpMult:1.0} },
};

console.log(`Window: ${candles[0].date} -> ${candles[candles.length-1].date}\n`);
console.log("── Full 8-year history ──");
for (const [label,cfg] of Object.entries(variants)) {
  const r = runBacktest(candles, cfg);
  console.log(`${label.padEnd(32)} trades=${String(r.trades).padStart(3)}  winrate=${r.winRate.toFixed(1).padStart(5)}%  PF=${r.pf.toFixed(2).padStart(5)}  maxDD=${r.maxDD.toFixed(1).padStart(5)}%  return=${r.totalReturn.toFixed(0).padStart(6)}%  CAGR=${r.cagr.toFixed(1)}%`);
}
const idx2y = candles.findIndex(c => c.date >= "2024-08-16");
const recent = candles.slice(Math.max(0, idx2y-60), candles.length);
console.log(`\n── Last ~2 years (from ${candles[idx2y].date}) ──`);
for (const [label,cfg] of Object.entries(variants)) {
  const r = runBacktest(recent, cfg);
  console.log(`${label.padEnd(32)} trades=${String(r.trades).padStart(3)}  winrate=${r.winRate.toFixed(1).padStart(5)}%  PF=${r.pf.toFixed(2).padStart(5)}  maxDD=${r.maxDD.toFixed(1).padStart(5)}%  return=${r.totalReturn.toFixed(1).padStart(6)}%`);
}
