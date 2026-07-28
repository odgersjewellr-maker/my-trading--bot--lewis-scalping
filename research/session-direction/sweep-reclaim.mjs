#!/usr/bin/env node
/**
 * SWEEP + RECLAIM — deep-dive on the winning trigger, traded properly.
 * -------------------------------------------------------------------
 * Setup: after London sets direction D, price runs (sweeps) the London high/low
 * against D — a stop grab near the US open — then closes back inside the range.
 * Enter on that reclaim in direction D, with a STRUCTURAL stop just beyond the
 * swept wick (so 1R is the natural risk), and either let it run to the session
 * close or take a kR target. Reports results in R units, per-year, long vs short.
 *
 *   node sweep-reclaim.mjs <ohlcv-minute.csv[.gz]>
 *
 * Verdict (BTC 2019+): the LONG side (buy after a red London) is the standout —
 * ~PF 2 stop→close, positive in 5 of 6 years; the short side is weak (long bias).
 * Caveats: low win rate (~26-29%), tight stop (~0.33% = 1R) so fees eat 0.15-0.3R,
 * and the fat right tail depends on trend days. See docs/research/london-ny-direction.md.
 */
import fs from "fs";import zlib from "zlib";import readline from "readline";
const FILE=process.argv[2];
const L_OPEN=7, NY_OPEN=12, NY_END=20;
const GATE_LO=12.5, GATE_HI=18.0, BUF=0.0005; // stop buffer beyond wick
function makeStream(p){const r=fs.createReadStream(p);return p.endsWith(".gz")?r.pipe(zlib.createGunzip()):r;}
let header=null,iTs,iO,iH,iL,iC,iV;
function detect(c){const l=c.map(x=>x.trim().toLowerCase());const f=(...n)=>l.findIndex(x=>n.includes(x));iTs=f("timestamp","time","date");iO=f("open");iH=f("high");iL=f("low");iC=f("close");iV=f("volume","vol");}
function parseTs(v){v=v.trim();if(/^\d+$/.test(v)){let n=Number(v);if(v.length>=13)n=Math.floor(n/1000);return new Date(n*1000);}return new Date(v.replace(" ","T")+"Z");}
const sign=x=>x>0?1:(x<0?-1:0),mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const med=a=>{const s=a.slice().sort((x,y)=>x-y);return s.length?s[Math.floor(s.length/2)]:0;};
const pct=x=>(100*x).toFixed(2)+"%";
const trades=[]; // {year,D,risk,entT, rClose, r2, r3}
let curKey=null,day=null;
function newDay(dow){return {dow,lOpen:null,lHigh:-1e18,lLow:1e18,boundary:null,mins:[]};}

function finalize(){
  if(!day)return;
  const {dow,lOpen,lHigh,lLow,boundary,mins}=day;
  if(dow===0||dow===6||lOpen===null||boundary===null||mins.length<120)return;
  const D=sign(boundary-lOpen);if(D===0)return;
  const year=+curKey.slice(0,4);
  // find sweep + reclaim
  let swept=false, ext=D>0?1e18:-1e18, fire=-1;
  for(let i=0;i<mins.length;i++){const m=mins[i];
    if(D>0){ if(m.l<lLow){swept=true; if(m.l<ext)ext=m.l;} else if(swept&&m.c>lLow&&m.clock>=GATE_LO&&m.clock<GATE_HI){fire=i;break;} }
    else   { if(m.h>lHigh){swept=true; if(m.h>ext)ext=m.h;} else if(swept&&m.c<lHigh&&m.clock>=GATE_LO&&m.clock<GATE_HI){fire=i;break;} } }
  if(fire<0)return;
  const entry=mins[fire].c;
  const stop = D>0 ? ext*(1-BUF) : ext*(1+BUF);
  const risk = Math.abs(entry-stop)/entry;
  if(!(risk>0.0008)) return;           // skip degenerate (entry basically at wick)
  // simulate: structural stop, targets at kR; also close-exit
  const sim=(k)=>{ const tgt = D>0 ? entry*(1+k*risk) : entry*(1-k*risk);
    for(let i=fire+1;i<mins.length;i++){const m=mins[i];
      if(D>0){ if(m.l<=stop)return -1; if(m.h>=tgt)return k; }
      else   { if(m.h>=stop)return -1; if(m.l<=tgt)return k; } }
    return D*(mins[mins.length-1].c-entry)/entry/risk; // open at close, in R
  };
  const rClose=(()=>{ for(let i=fire+1;i<mins.length;i++){const m=mins[i];
      if(D>0){ if(m.l<=stop)return -1; } else { if(m.h>=stop)return -1; } }
      return D*(mins[mins.length-1].c-entry)/entry/risk; })(); // stop-or-close, in R
  trades.push({year,D,risk,entT:mins[fire].clock,rClose,r2:sim(2),r3:sim(3)});
}
const rl=readline.createInterface({input:makeStream(FILE),crlfDelay:Infinity});
rl.on("line",line=>{if(!line)return;if(header===null){header=line;detect(line.split(","));return;}
  const p=line.split(",");const d=parseTs(p[iTs]);if(Number.isNaN(d.getTime()))return;
  const hh=d.getUTCHours();if(hh<L_OPEN||hh>=NY_END)return;
  const key=d.toISOString().slice(0,10);if(+key.slice(0,4)<2019)return;
  if(key!==curKey){finalize();curKey=key;day=newDay(d.getUTCDay());}
  const mm=d.getUTCMinutes(),o=+p[iO],hi=+p[iH],lo=+p[iL],c=+p[iC],v=iV>=0?+p[iV]:0;if(!(o>0)||!(c>0))return;
  if(hh<NY_OPEN){if(day.lOpen===null)day.lOpen=o;if(hi>day.lHigh)day.lHigh=hi;if(lo<day.lLow)day.lLow=lo;}
  else{if(day.boundary===null)day.boundary=o;day.mins.push({clock:hh+mm/60,o,h:hi,l:lo,c,v});}
});
rl.on("close",()=>{report();});

function expec(rs,key){ // rs = trade array, key = which R column
  const R=rs.map(t=>t[key]); const w=R.filter(x=>x>0).length/R.length;
  const pf=(()=>{const wp=R.filter(x=>x>0).reduce((s,x)=>s+x,0),lp=Math.abs(R.filter(x=>x<0).reduce((s,x)=>s+x,0));return lp?wp/lp:99;})();
  return {n:R.length,win:w,avgR:mean(R),pf};
}
function report(){
  console.log(`=== SWEEP + RECLAIM with STRUCTURAL stop (beyond the wick) [2019+] ===`);
  console.log(`   entry = reclaim of London level in London's dir; stop = swept wick; results in R (risk units)\n`);
  console.log(`   median risk/trade: ${pct(med(trades.map(t=>t.risk)))}  median entry: ${(()=>{const t=med(trades.map(x=>x.entT));return String(Math.floor(t)).padStart(2,'0')+':'+String(Math.round((t%1)*60)).padStart(2,'0');})()} UTC  fires ${trades.length} days\n`);
  const longs=trades.filter(t=>t.D<0), shorts=trades.filter(t=>t.D>0);
  const show=(name,rs)=>{ if(rs.length<20){console.log(`   ${name}: n=${rs.length} (few)`);return;}
    const c=expec(rs,'rClose'),t2=expec(rs,'r2'),t3=expec(rs,'r3');
    console.log(`   ${name.padEnd(26)} n=${String(rs.length).padStart(4)} | stop→close: win ${pct(c.win)} avgR ${c.avgR>=0?'+':''}${c.avgR.toFixed(2)} PF ${c.pf.toFixed(2)} | 2R tgt: win ${pct(t2.win)} avgR ${t2.avgR>=0?'+':''}${t2.avgR.toFixed(2)} PF ${t2.pf.toFixed(2)} | 3R: avgR ${t3.avgR>=0?'+':''}${t3.avgR.toFixed(2)}`);
  };
  show("ALL sweep+reclaim",trades);
  show("LONG (buy, red London)",longs);
  show("SHORT (sell, green London)",shorts);
  console.log(`\n   --- per-year (ALL, stop→close in R) ---`);
  for(let y=2019;y<=2024;y++){const rs=trades.filter(t=>t.year===y);if(rs.length<15)continue;
    const e=expec(rs,'rClose');console.log(`   ${y}: n=${String(rs.length).padStart(3)}  win ${pct(e.win)}  avgR ${e.avgR>=0?'+':''}${e.avgR.toFixed(2)}  PF ${e.pf.toFixed(2)}`);}
  console.log(`\n   1R ≈ ${pct(med(trades.map(t=>t.risk)))} move; avgR × risk ≈ gross % per trade. Costs ~0.05-0.10% = a fraction of 1R.`);
}
