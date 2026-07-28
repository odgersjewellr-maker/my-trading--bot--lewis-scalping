#!/usr/bin/env node
/**
 * TRIGGER LAB — what best times the resumption of London's direction in New York?
 * ------------------------------------------------------------------------------
 * The session study shows price fades London's direction right after the NY open,
 * then resumes it into the US close. This asks: which entry trigger catches that
 * resumption best? Per day it finds London dir D, then scans NY minutes for each
 * candidate trigger, enters in D at the first fire, and scores it two ways —
 * return held to the session close, and a fixed stop/target bracket — versus naive
 * clock baselines.
 *
 *   node triggers.mjs <ohlcv-minute.csv[.gz]>
 *   RED_ONLY=1 node triggers.mjs data.csv.gz   # only red/down-London days (D<0)
 *
 * Env: GATE_LO/GATE_HI (entry window UTC, def 12.5/18), STOP/TGT (bracket, def
 * 0.010/0.020), RED_ONLY (def 0). Needs 1-minute data with a volume column
 * (VWAP trigger). Verdict: momentum/breakout triggers don't beat entering at the
 * open; "London sweep + reclaim" (T3) does — see sweep-reclaim.mjs for the deep-dive.
 */
import fs from "fs";import zlib from "zlib";import readline from "readline";
const FILE=process.argv[2];
const L_OPEN=7, NY_OPEN=12, NY_END=20;
const GATE_LO=+(process.env.GATE_LO??12.5), GATE_HI=+(process.env.GATE_HI??18.0); // when entries allowed (UTC)
const STOP=+(process.env.STOP??0.010), TGT=+(process.env.TGT??0.020);            // bracket
const RED_ONLY=(process.env.RED_ONLY??process.env.LONG_ONLY??"0")==="1";         // restrict to red/down-London days (D<0); entering WITH dir = SHORT
function makeStream(p){const r=fs.createReadStream(p);return p.endsWith(".gz")?r.pipe(zlib.createGunzip()):r;}
let header=null,iTs,iO,iH,iL,iC,iV;
function detect(c){const l=c.map(x=>x.trim().toLowerCase());const f=(...n)=>l.findIndex(x=>n.includes(x));iTs=f("timestamp","time","date");iO=f("open");iH=f("high");iL=f("low");iC=f("close");iV=f("volume","vol");}
function parseTs(v){v=v.trim();if(/^\d+$/.test(v)){let n=Number(v);if(v.length>=13)n=Math.floor(n/1000);return new Date(n*1000);}return new Date(v.replace(" ","T")+"Z");}
const sign=x=>x>0?1:(x<0?-1:0),mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const med=a=>{const s=a.slice().sort((x,y)=>x-y);return s.length?s[Math.floor(s.length/2)]:0;};
const pct=x=>(100*x).toFixed(2)+"%";

// results accumulator: name -> {ret:[], brk:[], entT:[]}
const R={};
const add=(name,ret,brk,entT)=>{(R[name]??={ret:[],brk:[],entT:[]});R[name].ret.push(ret);R[name].brk.push(brk);R[name].entT.push(entT);};

let curKey=null, day=null;
function newDay(dow){return {dow,lOpen:null,lHigh:-1e18,lLow:1e18,boundary:null,mins:[]};}

function bracket(mins,ei,D,entry){ // scan forward for stop/target, else exit at close
  for(let i=ei+1;i<mins.length;i++){
    const m=mins[i];
    if(D>0){ if(m.l<=entry*(1-STOP))return -STOP; if(m.h>=entry*(1+TGT))return TGT; }
    else   { if(m.h>=entry*(1+STOP))return -STOP; if(m.l<=entry*(1-TGT))return TGT; }
  }
  return D*(mins[mins.length-1].c-entry)/entry;
}
function record(name,mins,ei,D){
  if(ei<0)return;
  const entry=mins[ei].c, closeR=D*(mins[mins.length-1].c-entry)/entry;
  add(name,closeR,bracket(mins,ei,D,entry),mins[ei].clock);
}

function finalize(){
  if(!day)return;
  const {dow,lOpen,lHigh,lLow,boundary,mins}=day;
  if(dow===0||dow===6||lOpen===null||boundary===null||mins.length<120)return;
  const D=sign(boundary-lOpen); if(D===0)return;
  if(RED_ONLY && D>0)return; // keep only red/down-London days (D<0); entering with dir = SHORT
  const gate=i=>mins[i].clock>=GATE_LO&&mins[i].clock<GATE_HI;

  // cumulative NY VWAP
  let cpv=0,cv=0; const vwap=mins.map(m=>{const tp=(m.h+m.l+m.c)/3;cpv+=tp*(m.v||0);cv+=(m.v||0);return cv>0?cpv/cv:m.c;});
  // opening ranges
  const rng=(a,b)=>{const s=mins.filter(m=>m.clock>=a&&m.clock<b);return s.length?{hi:Math.max(...s.map(m=>m.h)),lo:Math.min(...s.map(m=>m.l))}:null;};
  const orNY=rng(NY_OPEN,NY_OPEN+0.5), orUS=rng(13.5,14.0);

  // ---- baselines: enter at a fixed clock in D ----
  const at=clk=>{for(let i=0;i<mins.length;i++)if(mins[i].clock>=clk)return i;return -1;};
  record("B0 enter@NYopen(12:00)",mins,at(NY_OPEN),D);
  record("B1 enter@13:30 (US open)",mins,at(13.5),D);
  record("B2 enter@14:00",mins,at(14.0),D);

  // ---- T1 VWAP reclaim (was on wrong side, then closes back on D side) ----
  { let wrong=false, fire=-1;
    for(let i=0;i<mins.length;i++){const c=mins[i].c,w=vwap[i];
      if(D>0){ if(c<w)wrong=true; else if(wrong&&c>w&&gate(i)){fire=i;break;} }
      else   { if(c>w)wrong=true; else if(wrong&&c<w&&gate(i)){fire=i;break;} } }
    record("T1 VWAP reclaim",mins,fire,D); }

  // ---- T2a NY opening-range break (first 30m of NY) ----
  if(orNY){ let fire=-1; for(let i=0;i<mins.length;i++){ if(mins[i].clock<NY_OPEN+0.5||!gate(i))continue;
      if(D>0&&mins[i].c>orNY.hi){fire=i;break;} if(D<0&&mins[i].c<orNY.lo){fire=i;break;} }
    record("T2a NY-open range break",mins,fire,D); }

  // ---- T2b US opening-range break (13:30-14:00 range) ----
  if(orUS){ let fire=-1; for(let i=0;i<mins.length;i++){ if(mins[i].clock<14.0||!gate(i))continue;
      if(D>0&&mins[i].c>orUS.hi){fire=i;break;} if(D<0&&mins[i].c<orUS.lo){fire=i;break;} }
    record("T2b US-open range break",mins,fire,D); }

  // ---- T3 London sweep + reclaim (grab London low/high, close back inside) ----
  { let swept=false, fire=-1;
    for(let i=0;i<mins.length;i++){
      if(D>0){ if(mins[i].l<lLow)swept=true; else if(swept&&mins[i].c>lLow&&gate(i)){fire=i;break;} }
      else   { if(mins[i].h>lHigh)swept=true; else if(swept&&mins[i].c<lHigh&&gate(i)){fire=i;break;} } }
    record("T3 London sweep+reclaim",mins,fire,D); }

  // ---- T4 NY-open reclaim (dip through boundary, close back on D side) ----
  { let wrong=false, fire=-1;
    for(let i=0;i<mins.length;i++){
      if(D>0){ if(mins[i].l<boundary)wrong=true; else if(wrong&&mins[i].c>boundary&&gate(i)){fire=i;break;} }
      else   { if(mins[i].h>boundary)wrong=true; else if(wrong&&mins[i].c<boundary&&gate(i)){fire=i;break;} } }
    record("T4 NY-open reclaim",mins,fire,D); }

  // ---- T5 VWAP reclaim + must be after 13:30 (US-open-timed VWAP flip) ----
  { let wrong=false, fire=-1;
    for(let i=0;i<mins.length;i++){const c=mins[i].c,w=vwap[i];
      if(D>0){ if(c<w)wrong=true; else if(wrong&&c>w&&mins[i].clock>=13.5&&mins[i].clock<GATE_HI){fire=i;break;} }
      else   { if(c>w)wrong=true; else if(wrong&&c<w&&mins[i].clock>=13.5&&mins[i].clock<GATE_HI){fire=i;break;} } }
    record("T5 VWAP reclaim (post-13:30)",mins,fire,D); }
}

const rl=readline.createInterface({input:makeStream(FILE),crlfDelay:Infinity});
rl.on("line",line=>{if(!line)return;if(header===null){header=line;detect(line.split(","));return;}
  const p=line.split(",");const d=parseTs(p[iTs]);if(Number.isNaN(d.getTime()))return;
  const hh=d.getUTCHours();if(hh<L_OPEN||hh>=NY_END)return;
  const key=d.toISOString().slice(0,10);
  if(+key.slice(0,4)<2019)return;
  if(key!==curKey){finalize();curKey=key;day=newDay(d.getUTCDay());}
  const mm=d.getUTCMinutes(),o=+p[iO],hi=+p[iH],lo=+p[iL],c=+p[iC],v=iV>=0?+p[iV]:0;
  if(!(o>0)||!(c>0))return;
  if(hh<NY_OPEN){if(day.lOpen===null)day.lOpen=o;if(hi>day.lHigh)day.lHigh=hi;if(lo<day.lLow)day.lLow=lo;}
  else{if(day.boundary===null)day.boundary=o;day.mins.push({clock:hh+mm/60,o,h:hi,l:lo,c,v});}
});
rl.on("close",()=>{finalize();report();});

function report(){
  const base=R["B0 enter@NYopen(12:00)"].ret.length;
  console.log(`=== TRIGGER LAB — resume London's direction in NY  [2019+, ${RED_ONLY?"red/down-London only (D<0, short)":"all days"}] ===`);
  console.log(`   universe: ${base} days | bracket stop ${pct(STOP)} / target ${pct(TGT)} | entries ${GATE_LO}:00-${GATE_HI}:00 UTC\n`);
  console.log(`   trigger                        cover  close-exit:win  avg   PF  | bracket:win  avg   PF  | entT`);
  const order=Object.keys(R);
  const rows=order.map(name=>{
    const r=R[name]; const ret=r.ret, brk=r.brk;
    const cover=ret.length/base;
    const win=ret.filter(x=>x>0).length/ret.length;
    const avg=mean(ret);
    const pf=(a=>{const w=a.filter(x=>x>0).reduce((s,x)=>s+x,0),l=Math.abs(a.filter(x=>x<0).reduce((s,x)=>s+x,0));return l?w/l:99;})(ret);
    const bwin=brk.filter(x=>x>0).length/brk.length;
    const bavg=mean(brk);
    const bpf=(a=>{const w=a.filter(x=>x>0).reduce((s,x)=>s+x,0),l=Math.abs(a.filter(x=>x<0).reduce((s,x)=>s+x,0));return l?w/l:99;})(brk);
    return {name,cover,win,avg,pf,bwin,bavg,bpf,entT:med(r.entT)};
  });
  for(const x of rows){
    const hh=Math.floor(x.entT),mm=Math.round((x.entT%1)*60);
    console.log(`   ${x.name.padEnd(30)} ${pct(x.cover).padStart(6)}  ${pct(x.win).padStart(6)} ${(x.avg*100>=0?"+":"")}${(x.avg*100).toFixed(2)}% ${x.pf.toFixed(2)} |  ${pct(x.bwin).padStart(6)} ${(x.bavg*100>=0?"+":"")}${(x.bavg*100).toFixed(2)}% ${x.bpf.toFixed(2)} | ${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}`);
  }
  console.log(`\n   (cover=% days trigger fires; close-exit=hold to 20:00; bracket=stop/target first; entT=median entry UTC)`);
  console.log(`   note: returns GROSS. Subtract ~0.05-0.10% round-trip to judge tradeability.`);
}
