"""Absorption fade (inverted flow-watcher) — REAL fills, REAL fees, through the Gauntlet.

PRE-REGISTERED (frozen before results, per the Edge Machine ethos):

  Signal: the watcher's own fire — 5s order-flow imbalance >= 0.45 on >= $50k tape,
          3 confirm ticks. Both methods (15m gauntlet + tick event-study) say the
          spike is EXHAUSTION, so we FADE it: buy-spike -> short, sell-spike -> long.

  HONEST MAKER FILL WITH ADVERSE SELECTION (the make-or-break realism):
    fade a buy-spike by resting a SELL limit at Pf*(1+OFFSET); you FILL only if a
    later trade prints up THROUGH your limit within FILL_WINDOW (the spike continues
    into you — the bad entry), and you MISS if it reverses first (the easy win you
    don't get). Mirror for sell-spikes. This is why naive maker backtests lie.

  Exit: hold HOLD_S seconds, exit at market (taker).

  FROZEN PARAMS: OFFSET=3bp, FILL_WINDOW=10s, HOLD_S=300.
  FROZEN REALISTIC FEES (Binance USDⓈ-M): maker 2.0 bp/side, taker 5.0 bp/side,
    + 1.0 bp taker slippage on the market exit. Round trip = maker-in 2 + taker-out 6 = 8 bp.
  Cost-stress also reports a maker-BOTH best case (exit as a resting limit): 4 bp RT.

  DATA: N_WIN daily 6h windows of real Binance SOL aggTrades (regime diversity).
  Split: first 70% of windows = train, last 30% = holdout (run once).

  DECISION RULE: PASS iff pooled net-of-real-fee Sharpe > 0 AND holdout Sharpe > 0
    AND net mean bps/trade > 0 at the FROZEN (8bp) cost. Anything less: KILL.
    (A maker-both positive is reported but does NOT flip a KILL — it is a best case.)

Run:  python examples/run_absorption_fade.py
"""
from __future__ import annotations

import json, sys, time, urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

WINDOW_MS = 5000; THRESH = 0.45; MIN_NOTIONAL = 50000; CONFIRM = 3; CADENCE_MS = 1000
OFFSET = 0.0003; FILL_WINDOW_S = 10; HOLD_S = 300
MAKER_BP, TAKER_BP, SLIP_BP = 2.0, 5.0, 1.0
RT_FROZEN = MAKER_BP + TAKER_BP + SLIP_BP        # maker-in + taker-out = 8 bp
RT_MAKER_BOTH = 2 * MAKER_BP                      # 4 bp best case
N_WIN = 8; WIN_HOURS = 6; WIN_UTC_HOUR = 13

def get(u):
    return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent":"x"}), timeout=30))

def fetch_window(start_ms, hours):
    end_ms = start_ms + int(hours*3600e3); T,P,Q,BUY = [],[],[],[]
    batch = get(f"https://api.binance.com/api/v3/aggTrades?symbol=SOLUSDT&startTime={start_ms}&endTime={start_ms+3600000}&limit=1000")
    if not batch: return None
    fid = batch[0]["a"]
    while True:
        b = get(f"https://api.binance.com/api/v3/aggTrades?symbol=SOLUSDT&fromId={fid}&limit=1000")
        if not b: break
        for t in b:
            if t["T"] > end_ms: break
            T.append(t["T"]); P.append(float(t["p"])); Q.append(float(t["q"])); BUY.append(not t["m"])
        if b[-1]["T"] > end_ms or len(b) < 1000: break
        fid = b[-1]["a"]+1; time.sleep(0.03)
    if len(T) < 5000: return None
    return np.array(T), np.array(P), np.array(Q), np.array(BUY)

def fires_in(T,P,Q,BUY):
    notion = P*Q; out=[]; run={"+1":0,"-1":0}; lo=0; tcur=T[0]+WINDOW_MS; tend=T[-1]-(HOLD_S+FILL_WINDOW_S)*1000
    while tcur < tend:
        while T[lo] < tcur-WINDOW_MS: lo+=1
        hi=np.searchsorted(T,tcur,side="right")
        if hi>lo:
            bq=(Q[lo:hi]*BUY[lo:hi]).sum(); sq=(Q[lo:hi]*~BUY[lo:hi]).sum(); tot=bq+sq
            imb=(bq-sq)/tot if tot>0 else 0; thick=notion[lo:hi].sum()>=MIN_NOTIONAL
            for d,val in ((+1,imb),(-1,-imb)):
                k=f"{d:+d}"
                if thick and val>=THRESH:
                    run[k]+=1
                    if run[k]==CONFIRM: out.append((tcur, d))
                else: run[k]=0
        tcur+=CADENCE_MS
    return out

def sim_window(T,P,Q,BUY):
    """Honest adverse-selection maker fade. Returns list of gross bps (fill only)."""
    trades=[]
    for (tf,d) in fires_in(T,P,Q,BUY):
        i=np.searchsorted(T,tf); Pf=P[min(i,len(P)-1)]
        limit = Pf*(1+OFFSET) if d>0 else Pf*(1-OFFSET)     # rest ABOVE (short) / BELOW (long)
        # fill only if price trades THROUGH the limit within FILL_WINDOW (adverse selection)
        fw_end=tf+FILL_WINDOW_S*1000; j=i; filled=False
        while j<len(T) and T[j]<=fw_end:
            if (d>0 and P[j]>=limit) or (d<0 and P[j]<=limit): filled=True; break
            j+=1
        if not filled: continue                              # missed the (easy) reversal
        entry=limit; te=T[j]
        k=np.searchsorted(T,te+HOLD_S*1000); exitP=P[min(k,len(P)-1)]
        gross = -d*(exitP-entry)/entry*1e4                   # fade P&L in bps (short if d>0)
        trades.append((te, gross))
    return trades

def sharpe(x):
    x=np.asarray(x); return float(x.mean()/x.std(ddof=1)) if len(x)>2 and x.std()>0 else float("nan")

def main():
    print("="*76); print("EDGE MACHINE — Absorption Fade (real maker fills + real fees)"); print("="*76)
    print(f"frozen: offset {OFFSET*1e4:.0f}bp, hold {HOLD_S}s, fees maker {MAKER_BP}/taker {TAKER_BP}+{SLIP_BP}slip "
          f"-> RT {RT_FROZEN}bp (maker-both {RT_MAKER_BOTH}bp)\n")
    all_trades=[]; win_ok=0
    base = datetime.now(timezone.utc).replace(hour=WIN_UTC_HOUR, minute=0, second=0, microsecond=0) - timedelta(days=1)
    for i in range(N_WIN):
        start = int((base - timedelta(days=i)).timestamp()*1000)
        w = fetch_window(start, WIN_HOURS)
        if w is None: print(f"  window -{i}d: no data"); continue
        tr = sim_window(*w); all_trades.append(tr); win_ok+=1
        g=[x[1] for x in tr]
        print(f"  window -{i}d ({datetime.utcfromtimestamp(start/1000).date()}): {len(w[0])} trades, "
              f"{len(tr)} fills, gross {np.mean(g) if g else 0:+.2f}bp")
    if win_ok < 4: print("\ntoo few windows — abort."); return
    # pool, split by window (train = older 70%, holdout = newest 30%)
    order = list(reversed(all_trades))                       # oldest first
    cut = int(len(order)*0.7)
    train = [g for w in order[:cut] for (_,g) in w]
    hold  = [g for w in order[cut:] for (_,g) in w]
    allg  = [g for w in order for (_,g) in w]
    def net(g, rt): return np.array(g)-rt
    print(f"\npooled: {len(allg)} fills across {win_ok} windows (train {len(train)}, holdout {len(hold)})")
    print(f"  GROSS   mean {np.mean(allg):+.2f}bp  Sharpe {sharpe(allg):+.2f}  win% {100*np.mean(np.array(allg)>0):.0f}")
    for tag,rt in (("net @ RT 8bp (frozen)",RT_FROZEN),("net @ maker-both 4bp",RT_MAKER_BOTH)):
        n_all=net(allg,rt); n_tr=net(train,rt); n_ho=net(hold,rt)
        print(f"  {tag:<24} mean {n_all.mean():+.2f}bp  Sharpe {sharpe(n_all):+.2f}  "
              f"train Sh {sharpe(n_tr):+.2f}  holdout Sh {sharpe(n_ho):+.2f}")
    nf=net(allg,RT_FROZEN); nh=net(hold,RT_FROZEN)
    passed = sharpe(nf)>0 and sharpe(nh)>0 and nf.mean()>0
    print(f"\nVERDICT (frozen 8bp rule): {'PASS' if passed else 'KILL'}  "
          f"[net>0: {nf.mean()>0} | pooled Sh>0: {sharpe(nf)>0} | holdout Sh>0: {sharpe(nh)>0}]")

if __name__ == "__main__":
    main()
