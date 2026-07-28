#!/usr/bin/env node
/**
 * SWEEP + RECLAIM — deep-dive on the winning trigger, with PARTICIPATION FILTERS.
 * -----------------------------------------------------------------------------
 * Setup: after London sets direction D, price runs (sweeps) the London high/low
 * against D — a stop grab near the US open — then closes back inside the range.
 * Enter on that reclaim in direction D, with a STRUCTURAL stop just beyond the
 * swept wick (so 1R is the natural risk), and either let it run to the session
 * close or take a kR target. Reports results in R units, per-year, long vs short.
 *
 *   node sweep-reclaim.mjs <ohlcv-minute.csv[.gz]>
 *   NEWS_CSV=fomc-cpi-nfp.csv node sweep-reclaim.mjs data.csv.gz   # real calendar
 *
 * PARTICIPATION FILTERS (prior-art §: Zarattini "day in play" + Gao intraday
 * momentum — the edge should concentrate on high-volume / news days):
 *   - RVol   : opening-window volume (NY_OPEN..RVOL_END) vs its trailing median.
 *              Known before the typical entry, so it's a usable pre-trade gate.
 *   - RangeExp: opening-window range vs its trailing median (volatility proxy).
 *   - NFP    : first-Friday-of-month proxy for the 8:30 ET jobs release (13:30 UTC).
 *   - NEWS_CSV: optional file of YYYY-MM-DD event dates (FOMC/CPI/NFP/...) — if
 *              given, results are also split news vs non-news.
 * Env: RVOL_END (13.5), RVOL_LOOKBACK (20), RVOL_HI (1.2), RVOL_LO (0.8).
 *
 * We enter WITH London's direction on the reclaim, so: D<0 = red/down London =>
 * SHORT the failed bounce; D>0 = green/up London => LONG the failed dip.
 * Verdict (BTC 2019+): the SHORT side (sell after a red London) is the standout;
 * filters test whether restricting to high-participation days lifts it. Needs 1-min
 * data WITH a volume column. See docs/research/london-ny-direction.md.
 */
import fs from "fs";import zlib from "zlib";import readline from "readline";
const FILE=process.argv[2];
const L_OPEN=7, NY_OPEN=12, NY_END=20;
const GATE_LO=12.5, GATE_HI=18.0, BUF=0.0005; // stop buffer beyond wick
const RVOL_END=+(process.env.RVOL_END??13.5), RVOL_LOOKBACK=+(process.env.RVOL_LOOKBACK??20);
const RVOL_HI=+(process.env.RVOL_HI??1.2), RVOL_LO=+(process.env.RVOL_LO??0.8);
function makeStream(p){const r=fs.createReadStream(p);return p.endsWith(".gz")?r.pipe(zlib.createGunzip()):r;}

// optional real economic-calendar file
let NEWS=null;
if(process.env.NEWS_CSV){
  try{ const txt=fs.readFileSync(process.env.NEWS_CSV,"utf8"); NEWS=new Set(txt.match(/\d{4}-\d{2}-\d{2}/g)||[]);
    console.error(`[news] loaded ${NEWS.size} event dates from ${process.env.NEWS_CSV}`); }
  catch(e){ console.error(`[news] could not read ${process.env.NEWS_CSV}: ${e.message}`); }
}

let header=null,iTs,iO,iH,iL,iC,iV;
function detect(c){const l=c.map(x=>x.trim().toLowerCase());const f=(...n)=>l.findIndex(x=>n.includes(x));iTs=f("timestamp","time","date");iO=f("open");iH=f("high");iL=f("low");iC=f("close");iV=f("volume","vol");}
function parseTs(v){v=v.trim();if(/^\d+$/.test(v)){let n=Number(v);if(v.length>=13)n=Math.floor(n/1000);return new Date(n*1000);}return new Date(v.replace(" ","T")+"Z");}
const sign=x=>x>0?1:(x<0?-1:0),mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const med=a=>{const s=a.slice().sort((x,y)=>x-y);return s.length?s[Math.floor(s.length/2)]:0;};
const pct=x=>(100*x).toFixed(2)+"%";
const trailingMed=(arr,k)=>{const s=arr.slice(-k);if(s.length<10)return null;const t=s.slice().sort((a,b)=>a-b);return t[Math.floor(t.length/2)];};

const trades=[]; // {year,date,D,risk,entT,rClose,r2,r3, rvol,rangeExp,nfp,news}
const openVolHist=[], openRngHist=[]; // trailing baselines (weekdays)
let curKey=null,day=null;
function newDay(dow){return {dow,lOpen:null,lHigh:-1e18,lLow:1e18,boundary:null,mins:[]};}

function finalize(){
  if(!day)return;
  const {dow,lOpen,lHigh,lLow,boundary,mins}=day;
  if(dow===0||dow===6||lOpen===null||boundary===null||mins.length<120)return;
  const D=sign(boundary-lOpen);if(D===0)return;
  const year=+curKey.slice(0,4), dom=+curKey.slice(8,10);

  // --- participation metrics (computed BEFORE updating baselines -> no look-ahead) ---
  const owin=mins.filter(m=>m.clock>=NY_OPEN&&m.clock<RVOL_END);
  const openVol=owin.reduce((s,m)=>s+(m.v||0),0);
  const openRng=owin.length?(Math.max(...owin.map(m=>m.h))-Math.min(...owin.map(m=>m.l)))/boundary:0;
  const rvBase=trailingMed(openVolHist,RVOL_LOOKBACK), rgBase=trailingMed(openRngHist,RVOL_LOOKBACK);
  const rvol=(rvBase&&rvBase>0)?openVol/rvBase:null;
  const rangeExp=(rgBase&&rgBase>0)?openRng/rgBase:null;
  openVolHist.push(openVol); openRngHist.push(openRng);
  const nfp=(dow===5&&dom<=7);                       // first Friday ~ NFP release
  const news=NEWS?NEWS.has(curKey):null;

  // --- sweep + reclaim in London's direction ---
  let swept=false, ext=D>0?1e18:-1e18, fire=-1;
  for(let i=0;i<mins.length;i++){const m=mins[i];
    if(D>0){ if(m.l<lLow){swept=true; if(m.l<ext)ext=m.l;} else if(swept&&m.c>lLow&&m.clock>=GATE_LO&&m.clock<GATE_HI){fire=i;break;} }
    else   { if(m.h>lHigh){swept=true; if(m.h>ext)ext=m.h;} else if(swept&&m.c<lHigh&&m.clock>=GATE_LO&&m.clock<GATE_HI){fire=i;break;} } }
  if(fire<0)return;
  const entry=mins[fire].c;
  const stop=D>0?ext*(1-BUF):ext*(1+BUF);
  const risk=Math.abs(entry-stop)/entry;
  if(!(risk>0.0008))return;
  const sim=(k)=>{ const tgt=D>0?entry*(1+k*risk):entry*(1-k*risk);
    for(let i=fire+1;i<mins.length;i++){const m=mins[i];
      if(D>0){ if(m.l<=stop)return -1; if(m.h>=tgt)return k; } else { if(m.h>=stop)return -1; if(m.l<=tgt)return k; } }
    return D*(mins[mins.length-1].c-entry)/entry/risk; };
  const rClose=(()=>{ for(let i=fire+1;i<mins.length;i++){const m=mins[i];
      if(D>0){ if(m.l<=stop)return -1; } else { if(m.h>=stop)return -1; } }
      return D*(mins[mins.length-1].c-entry)/entry/risk; })();
  trades.push({year,date:curKey,D,risk,entT:mins[fire].clock,rClose,r2:sim(2),r3:sim(3),rvol,rangeExp,nfp,news});
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

function expec(rs,key){const R=rs.map(t=>t[key]);const w=R.filter(x=>x>0).length/R.length;
  const pf=(()=>{const wp=R.filter(x=>x>0).reduce((s,x)=>s+x,0),lp=Math.abs(R.filter(x=>x<0).reduce((s,x)=>s+x,0));return lp?wp/lp:99;})();
  return {n:R.length,win:w,avgR:mean(R),pf};}
function line(label,rs){ if(rs.length<20){console.log(`   ${label.padEnd(30)} n=${String(rs.length).padStart(4)}  (too few)`);return;}
  const e=expec(rs,'rClose'); console.log(`   ${label.padEnd(30)} n=${String(rs.length).padStart(4)}  win ${pct(e.win).padStart(6)}  avgR ${e.avgR>=0?'+':''}${e.avgR.toFixed(2)}  PF ${e.pf.toFixed(2)}`);}

function report(){
  const reds=trades.filter(t=>t.D<0), greens=trades.filter(t=>t.D>0), withRV=trades.filter(t=>t.rvol!=null);
  console.log(`=== SWEEP + RECLAIM with PARTICIPATION FILTERS [2019+] (stop→close, R units) ===`);
  console.log(`   enter WITH London's dir on the reclaim: D<0 red/down London => SHORT; D>0 green/up London => LONG.`);
  console.log(`   fires ${trades.length} days | ${withRV.length} have RVol history | median risk ${pct(med(trades.map(t=>t.risk)))} | RVol window ${NY_OPEN}:00-${RVOL_END}:00 UTC\n`);
  console.log(`  -- baseline by side --`);
  line("ALL sweep+reclaim",trades);
  line("SELL after RED London (D<0)",reds);
  line("BUY  after GREEN London (D>0)",greens);
  console.log(`\n  -- per-year (stop→close avgR / win), robustness of each side --`);
  for(let y=2019;y<=2024;y++){const ry=reds.filter(t=>t.year===y),gy=greens.filter(t=>t.year===y);
    if(ry.length+gy.length<10)continue;
    const er=ry.length?expec(ry,'rClose'):null,eg=gy.length?expec(gy,'rClose'):null;
    console.log(`   ${y}:  SELL/red  n=${String(ry.length).padStart(3)} avgR ${er?(er.avgR>=0?'+':'')+er.avgR.toFixed(2):' n/a '} win ${er?pct(er.win):'  n/a'}  |  BUY/green n=${String(gy.length).padStart(3)} avgR ${eg?(eg.avgR>=0?'+':'')+eg.avgR.toFixed(2):' n/a '} win ${eg?pct(eg.win):'  n/a'}`);}
  console.log(`\n  -- RELATIVE VOLUME (opening ${NY_OPEN}:00-${RVOL_END}:00 vs trailing-${RVOL_LOOKBACK}d median) --`);
  line(`RVol HIGH (>=${RVOL_HI})  ALL`, withRV.filter(t=>t.rvol>=RVOL_HI));
  line(`RVol MID (${RVOL_LO}-${RVOL_HI})   ALL`, withRV.filter(t=>t.rvol>=RVOL_LO&&t.rvol<RVOL_HI));
  line(`RVol LOW (<${RVOL_LO})    ALL`, withRV.filter(t=>t.rvol<RVOL_LO));
  line(`RVol HIGH · SELL/red side`, withRV.filter(t=>t.rvol>=RVOL_HI&&t.D<0));
  console.log(`\n  -- RANGE EXPANSION (opening range vs trailing-${RVOL_LOOKBACK}d median) --`);
  line("RangeExp HIGH (>=1.3) ALL", trades.filter(t=>t.rangeExp!=null&&t.rangeExp>=1.3));
  line("RangeExp LOW  (<1.0) ALL", trades.filter(t=>t.rangeExp!=null&&t.rangeExp<1.0));
  console.log(`\n  -- NEWS (NFP first-Friday proxy${NEWS?" + NEWS_CSV":""}) --`);
  line("NFP-proxy day  ALL", trades.filter(t=>t.nfp));
  line("non-NFP day    ALL", trades.filter(t=>!t.nfp));
  if(NEWS){ line("NEWS_CSV day   ALL", trades.filter(t=>t.news)); line("non-news day   ALL", trades.filter(t=>t.news===false)); }
  console.log(`\n  -- STACKED (best filter) --`);
  line("SELL/red + RVol HIGH", withRV.filter(t=>t.D<0&&t.rvol>=RVOL_HI));
  console.log(`\n   1R ≈ ${pct(med(trades.map(t=>t.risk)))}. avgR × risk ≈ gross %/trade; costs ~0.05-0.10% = 0.15-0.30R.`);
  console.log(`   RVol/RangeExp use only pre-entry data (trailing median + opening window before the typical ${((t)=>String(Math.floor(t)).padStart(2,'0')+':'+String(Math.round((t%1)*60)).padStart(2,'0'))(med(trades.map(t=>t.entT)))} entry).`);
}
