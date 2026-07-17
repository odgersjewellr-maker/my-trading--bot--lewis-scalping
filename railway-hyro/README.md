# Railway 24/7 host for the HyroTrader trial bot

Always-on EU-region worker that runs the trial bot every 15 minutes (at :30s
past the quarter-hour) and commits state back to this repo. Replaces the PC
scheduled task `NKB-HyroTrader-Trial` — **never run both at once.**

## Deploy (Railway dashboard, ~5 minutes)

1. **New Project → Deploy from GitHub repo** → pick
   `my-trading--bot--lewis-scalping`.
2. Service **Settings → Build**: set **Root Directory** = `railway-hyro`
   (it will find the Dockerfile there).
3. **Settings → Deploy → Regions**: choose **EU (Amsterdam)** — mandatory.
   Bybit's demo API returns HTTP 403 from US IPs; the boot check will refuse
   to trade if the region is blocked.
4. **Settings → Deploy → Watch paths**: `railway-hyro/**` — otherwise every
   state commit the bot pushes would trigger a pointless redeploy.
5. **Variables** (you paste these yourself; never through chat):
   - `HYROTRADER_API_KEY` / `HYROTRADER_API_SECRET` — from `hyrotrader\.env`
   - `HYROTRADER_BASE_URL` = `https://api-demo.bybit.com`
   - `GH_TOKEN` — GitHub fine-grained token, this repo only, Contents:
     read+write (state commits)
   - `TRADING_ENABLED` = `false`  ← leave false on first deploy
6. Deploy. Logs should show `reachability check: OK` and
   `DRY (heartbeat only)` cycles every 15 min.

## Cutover checklist (the double-trade guard)

1. Watch ≥1 clean DRY cycle in Railway logs (reachability OK from EU).
2. Disable the PC task:
   `Disable-ScheduledTask -TaskName "NKB-HyroTrader-Trial"`
3. Flip `TRADING_ENABLED` = `true` in Railway variables (service restarts).
4. Confirm the next cycle's log shows a full bot run and (if state changed)
   a `HYRO-TRIAL run ...` commit in the repo.

Rollback = reverse the order: set `TRADING_ENABLED=false` first, then
re-enable the PC task.
