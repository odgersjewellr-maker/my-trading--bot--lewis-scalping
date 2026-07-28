#!/usr/bin/env node
/**
 * EXIT LAB — win rate is a dial set by the EXIT, not a property of the entry edge.
 * -----------------------------------------------------------------------------
 * Same sweep+reclaim entries, many exit policies (fixed R/%, breakeven-after-1R,
 * scale-out, time stops) so you can pick your spot on the win-rate/reward curve.
 * "Hold to close" maximises avg winner but tanks win rate; scaling half off at +1R
 * roughly doubles win rate while keeping most of the edge.
 *
 *   node exit-lab.mjs <ohlcv-minute.csv[.gz]>
 *   SIDE=red   (default) red/down-London = SHORT the failed bounce (the stronger side)
 *   SIDE=green            green/up-London = LONG the failed dip
 *   SIDE=all              both
 *
 * Columns: win = % net positive; no-loss = % ending >= -0.05R (scratches count);
 * avgR = expectancy in R; ≈%/trade = avgR × median 1R (gross, before fees).
 */
import fs from "fs";import zlib from "zlib";import readline from "readline";
const FILE=process.argv[2];
const L_OPEN=7,NY_OPEN=12,NY_END=20,GATE_LO=12.5,GATE_HI=18,BUF=0.0005;
const SIDE=process.env.SIDE??"red"; // red = D<0 (short), green = D>0 (long), all
function mk(p){const r=fs.createReadStream(p);return p.endsWith(".gz")?r.pipe(zlib.createGunzip()):r;}
let H=null,iTs,iO,iH,iL,iC;
function det(c){const l=c.map(x=>x.trim().toLowerCase());const f=(...n)=>l.findIndex(x=>n.includes(x));iTs=f("timestamp","time","date");iO=f("open");iH=f("high");iL=f("low");iC=f("close");}
function ts(v){v=v.trim();if(/^\d+$/.test(v)){let n=+v;if(v.length>=13)n=Math.floor(n/1000);return new Date(n*1000);}return new Date(v.replace(" ","T")+"Z");}
const sign=x=>x>0?1:x<0?-1:0,mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const med=a=>{const s=a.slice().sort((x,y)=>x-y);return s.length?s[Math.floor(s.length/2)]:0;};
const pct=x=>(100*x).toFixed(1)+"%";
let cur=null,day=null;const TR=[]; // each: {D,E,S,r,fire,mins}
function fin(){if(!day)return;const{dow,lOpen,lHigh,lLow,boundary,mins}=day;
  if(dow===0||dow===6||lOpen===null||boundary===null||mins.length<120)return;const D=sign(boundary-lOpen);if(D===0)return;
  let sw=false,ext=D>0?1e18:-1e18,fire=-1;
  for(let i=0;i<mins.length;i++){const m=mins[i];
    if(D>0){if(m.l<lLow){sw=true;if(m.l<ext)ext=m.l;}else if(sw&&m.c>lLow&&m.clock>=GATE_LO&&m.clock<GATE_HI){fire=i;break;}}
    else{if(m.h>lHigh){sw=true;if(m.h>ext)ext=m.h;}else if(sw&&m.c<lHigh&&m.clock>=GATE_LO&&m.clock<GATE_HI){fire=i;break;}}}
  if(fire<0)return;const E=mins[fire].c,S=D>0?ext*(1-BUF):ext*(1+BUF),r=Math.abs(E-S)/E;if(!(r>0.0008))return;
  if(SIDE==="red"&&D>=0)return; if(SIDE==="green"&&D<=0)return;
  TR.push({D,E,S,r,fire,mins});}
const rl=readline.createInterface({input:mk(FILE),crlfDelay:Infinity});
rl.on("line",l=>{if(!l)return;if(H===null){H=l;det(l.split(","));return;}
  const p=l.split(","),d=ts(p[iTs]);if(isNaN(d))return;const hh=d.getUTCHours();if(hh<L_OPEN||hh>=NY_END)return;
  const k=d.toISOString().slice(0,10);if(+k.slice(0,4)<2019)return;
  if(k!==cur){fin();cur=k;day={dow:d.getUTCDay(),lOpen:null,lHigh:-1e18,lLow:1e18,boundary:null,mins:[]};}
  const mm=d.getUTCMinutes(),o=+p[iO],hi=+p[iH],lo=+p[iL],c=+p[iC];if(!(o>0)||!(c>0))return;
  if(hh<NY_OPEN){if(day.lOpen===null)day.lOpen=o;if(hi>day.lHigh)day.lHigh=hi;if(lo<day.lLow)day.lLow=lo;}
  else{if(day.boundary===null)day.boundary=o;day.mins.push({clock:hh+mm/60,o,h:hi,l:lo,c});}});
rl.on("close",()=>report());

// exit policies -> return R multiple
function targetK(t,k){const{D,E,S,r,fire,mins}=t;const tgt=D>0?E*(1+k*r):E*(1-k*r);
  for(let i=fire+1;i<mins.length;i++){const m=mins[i];
    const adv=D>0?m.l<=S:m.h>=S, hit=D>0?m.h>=tgt:m.l<=tgt;
    if(adv)return -1; if(hit)return k;}
  return D*(mins[mins.length-1].c-E)/E/r;}
function beAfter(t,trig){const{D,E,S,r,fire,mins}=t;let stop=S,reached=false;
  for(let i=fire+1;i<mins.length;i++){const m=mins[i];
    const adv=D>0?m.l<=stop:m.h>=stop; if(adv)return reached?0:-1;
    const hitR=D>0?m.h>=E*(1+trig*r):m.l<=E*(1-trig*r); if(!reached&&hitR){reached=true;stop=E;}}
  return D*(mins[mins.length-1].c-E)/E/r;}
function scaleHalf(t,trig){const{D,E,S,r,fire,mins}=t;let stop=S,reached=false;
  for(let i=fire+1;i<mins.length;i++){const m=mins[i];
    const adv=D>0?m.l<=stop:m.h>=stop; if(adv)return reached?0.5*trig+0.5*0:-1;
    const hitR=D>0?m.h>=E*(1+trig*r):m.l<=E*(1-trig*r); if(!reached&&hitR){reached=true;stop=E;}}
  const closeR=D*(mins[mins.length-1].c-E)/E/r;
  return reached?0.5*trig+0.5*closeR:closeR;}
function timeExit(t,hrs){const{D,E,S,r,fire,mins}=t;const exitClock=mins[fire].clock+hrs;
  for(let i=fire+1;i<mins.length;i++){const m=mins[i];
    if(D>0?m.l<=S:m.h>=S)return -1; if(m.clock>=exitClock)return D*(m.c-E)/E/r;}
  return D*(mins[mins.length-1].c-E)/E/r;}
const holdClose=t=>{const{D,E,S,r,fire,mins}=t;for(let i=fire+1;i<mins.length;i++){const m=mins[i];if(D>0?m.l<=S:m.h>=S)return -1;}return D*(mins[mins.length-1].c-E)/E/r;};

function stat(name,fn){const R=TR.map(fn);const win=R.filter(x=>x>0.001).length/R.length;
  const noLoss=R.filter(x=>x>=-0.05).length/R.length;const avg=mean(R);
  const wp=R.filter(x=>x>0).reduce((s,x)=>s+x,0),lp=Math.abs(R.filter(x=>x<0).reduce((s,x)=>s+x,0));
  const pf=lp?wp/lp:99;const mr=med(TR.map(t=>t.r));
  console.log(`   ${name.padEnd(26)} win ${pct(win).padStart(6)}  no-loss ${pct(noLoss).padStart(6)}  avgR ${avg>=0?'+':''}${avg.toFixed(2)}  PF ${pf.toFixed(2)}  ≈${(avg*mr*100>=0?'+':'')}${(avg*mr*100).toFixed(3)}%/trade`);}
function report(){
  console.log(`=== EXIT LAB — sweep+reclaim, ${SIDE.toUpperCase()} side, n=${TR.length}  (median 1R ≈ ${pct(med(TR.map(t=>t.r)))}) ===`);
  console.log(`   win = % net positive; no-loss = % ending >= -0.05R (incl. scratches). Gross, 2019+.\n`);
  stat("hold to close (current)",holdClose);
  stat("target 1R",t=>targetK(t,1));
  stat("target 1.5R",t=>targetK(t,1.5));
  stat("target 2R",t=>targetK(t,2));
  stat("stop→BE after +1R",t=>beAfter(t,1));
  stat("scale ½ at +1R, rest→close",t=>scaleHalf(t,1));
  stat("scale ½ at +1.5R, rest→close",t=>scaleHalf(t,1.5));
  stat("time exit +2h",t=>timeExit(t,2));
  stat("time exit +3h",t=>timeExit(t,3));
  console.log(`\n   Read: targets/scale-out RAISE win rate but SHRINK avg winner — the edge is a dial.`);
}
