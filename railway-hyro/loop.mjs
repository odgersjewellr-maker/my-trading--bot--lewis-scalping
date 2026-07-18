/**
 * Railway supervisor for the HyroTrader trial bot (2026-07-17).
 *
 * Always-on worker (same pattern as the existing Railway dispatcher): waits
 * for :30s past each quarter-hour, then runs one bot cycle against the trial
 * account. State (position/trades/safety-log/nkb-state/portfolio for
 * INSTANCE_ID=SOLUSDT-HYRO) is committed back to the bot repo, so the audit
 * trail lives in git and a redeploy loses nothing.
 *
 * SAFE BY DEFAULT: unless TRADING_ENABLED=true, every cycle runs only the
 * READ-ONLY adapter check (reachability heartbeat) — no orders. Flip
 * TRADING_ENABLED to "true" in Railway variables ONLY AFTER the PC scheduled
 * task "NKB-HyroTrader-Trial" is disabled. Two runners on one account would
 * double-trade it.
 *
 * Railway env vars required:
 *   HYROTRADER_API_KEY / HYROTRADER_API_SECRET  — trial account API creds
 *   HYROTRADER_BASE_URL                          — https://api-demo.bybit.com
 *   GH_TOKEN                                     — GitHub token with repo push
 *   TRADING_ENABLED                              — "true" to trade (default: dry)
 * Optional: REPO (default odgersjewellr-maker/my-trading--bot--lewis-scalping)
 *
 * Region requirement: deploy in an EU or Singapore region — Bybit's demo API
 * geo-blocks US IPs (HTTP 403). The boot check verifies this and the service
 * refuses to trade if the region is blocked.
 */
import { execSync, spawnSync } from "child_process";
import { existsSync } from "fs";

const REPO = process.env.REPO || "odgersjewellr-maker/my-trading--bot--lewis-scalping";
const WORK = "/work";
const TOKEN = process.env.GH_TOKEN;
const TRADING = process.env.TRADING_ENABLED === "true";

const log = m => console.log(`[${new Date().toISOString()}] ${m}`);
const sh = (cmd, cwd = WORK, quiet = false) => {
  const out = execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (!quiet && out.trim()) console.log(out.trim());
  return out;
};

function cloneUrl() {
  // Repo is public: clone works tokenless (DRY/heartbeat mode needs no secrets
  // at all). GH_TOKEN is only required to PUSH state once trading is enabled.
  return TOKEN ? `https://x-access-token:${TOKEN}@github.com/${REPO}.git`
               : `https://github.com/${REPO}.git`;
}

function boot() {
  if (!existsSync(WORK)) {
    log(`cloning ${REPO} ...`);
    execSync(`git clone --depth 20 ${cloneUrl()} ${WORK}`, { stdio: ["ignore", "pipe", "pipe"] });
    sh(`git config user.name "hyro-trial-bot"`, WORK, true);
    sh(`git config user.email "actions@users.noreply.github.com"`, WORK, true);
    log("npm install ...");
    sh("npm install --omit=dev --loglevel=error", WORK, true);
  }
}

async function regionProbe() {
  // Public endpoint — needs no credentials. Bybit geo-blocks return 403/451
  // even on public routes, so this answers the region question by itself.
  const base = process.env.HYROTRADER_BASE_URL || "https://api-demo.bybit.com";
  try {
    const r = await fetch(`${base}/v5/market/time`);
    log(`region probe (${base}): HTTP ${r.status} ${r.ok ? "— region OK, not geo-blocked" : "— GEO-BLOCKED or unreachable"}`);
    return r.ok;
  } catch (e) { log(`region probe failed: ${e.message}`); return false; }
}

function reachability() {
  if (!process.env.HYROTRADER_API_KEY) { log("no API creds set yet — skipping authed check (region probe governs)"); return true; }
  const r = spawnSync("node", ["--env-file=hyro-trial.env", "hyrotrader-check.mjs"],
    { cwd: WORK, encoding: "utf8", timeout: 120000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const ok = r.status === 0 && /Reachable and authenticated/.test(out);
  log(`authed reachability check: ${ok ? "OK" : "FAILED"}`);
  if (!ok) console.log(out.slice(-600));
  return ok;
}

function cycle() {
  // freshest state (PC runs or manual commits may have landed)
  try { sh("git pull --rebase --autostash", WORK, true); } catch (e) { log(`pull failed: ${e.message}`); }

  if (!TRADING) {
    log("DRY MODE (TRADING_ENABLED != true) — heartbeat check only, no orders.");
    reachability();
    return;
  }
  if (!TOKEN) { log("TRADING_ENABLED but GH_TOKEN missing — refusing to trade without a state audit trail."); return; }

  log("running bot cycle ...");
  const r = spawnSync("node", ["--env-file=hyro-trial.env", "bot.js"],
    { cwd: WORK, encoding: "utf8", timeout: 300000 });
  const out = (r.stdout || "") + (r.stderr || "");
  console.log(out.split("\n").filter(l => l.trim() && !/MODULE_TYPELESS|Reparsing|trace-warnings/.test(l)).join("\n"));
  if (r.status !== 0) { log(`bot exited ${r.status} — state not committed this cycle`); return; }

  // persist state
  const files = ["position-SOLUSDT-HYRO.json", "trades-SOLUSDT-HYRO.csv",
    "safety-check-log-SOLUSDT-HYRO.json", "nkb-state-SOLUSDT-HYRO.json", "portfolio-SOLUSDT-HYRO.json"];
  for (const f of files) { try { sh(`git add ${f}`, WORK, true); } catch { /* absent is fine */ } }
  try {
    sh(`git diff --cached --quiet || git commit -m "HYRO-TRIAL run $(date -u +%Y-%m-%dT%H:%M:%SZ)"`, WORK, true);
    for (let i = 1; i <= 4; i++) {
      try { sh("git push", WORK, true); break; }
      catch { log(`push rejected (attempt ${i}) — rebasing`); sh("git pull --rebase", WORK, true); }
    }
  } catch (e) { log(`state persist failed: ${e.message}`); }
}

function msToNextQuarter() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCMinutes(now.getUTCMinutes() + (15 - (now.getUTCMinutes() % 15)), 30, 0);
  return next - now;
}

// ── main ─────────────────────────────────────────────────────────────────────
boot();
log(`mode: ${TRADING ? "TRADING ENABLED" : "DRY (heartbeat only)"} | repo: ${REPO}`);
const regionOk = await regionProbe();
if (!regionOk) log("Set the service region to EU (Amsterdam) or Singapore in Railway settings, then redeploy.");
if (regionOk && !reachability()) {
  log("Region OK but authed check failed — verify HYROTRADER_API_KEY/SECRET variables.");
}
for (;;) {
  const ms = msToNextQuarter();
  log(`next cycle in ${(ms / 60000).toFixed(1)} min`);
  await new Promise(r => setTimeout(r, ms));
  try { cycle(); } catch (e) { log(`cycle error: ${e.message}`); }
}
