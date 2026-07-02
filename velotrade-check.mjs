/**
 * Velotrade adapter self-test — run against the DEMO environment first.
 *
 * Usage:
 *   node --env-file=.env velotrade-check.mjs            # read-only: login, metrics, positions
 *   node --env-file=.env velotrade-check.mjs --order    # ALSO places a far-from-market stop
 *                                                       # order and immediately cancels it
 *
 * Requires in .env: VELOTRADE_USERNAME, VELOTRADE_PASSWORD, VELOTRADE_ACCOUNT
 * Optional: VELOTRADE_BASE_URL, VELOTRADE_DOMAIN, VELOTRADE_INSTRUMENT, SYMBOL
 *
 * Prints NO credentials or session tokens. Verifies the DEMO-VERIFY items in
 * velotrade.js: response field names for equity/balance, positions shape, and
 * (with --order) the stop-order price field and cancel endpoint.
 */
import { vtAccountMetrics, vtPositions, vtPlaceStopOrder, vtCancelOrder } from "./velotrade.js";

const PLACE_ORDER = process.argv.includes("--order");

function mask(v) {
  if (v == null) return "(not set)";
  const s = String(v);
  return s.length <= 4 ? "***" : `${s.slice(0, 2)}***${s.slice(-2)}`;
}

console.log("Velotrade adapter self-test");
console.log(`  Base URL:   ${process.env.VELOTRADE_BASE_URL || "https://dx.velotrade.com"}`);
console.log(`  Username:   ${mask(process.env.VELOTRADE_USERNAME)}`);
console.log(`  Account:    ${mask(process.env.VELOTRADE_ACCOUNT)}`);
console.log(`  Instrument: ${process.env.VELOTRADE_INSTRUMENT || "(derived from SYMBOL)"}\n`);

try {
  console.log("1) Login + account metrics...");
  const m = await vtAccountMetrics();
  console.log(`   equity:  ${m.equity != null ? "$" + m.equity.toFixed(2) : "⚠️ NOT FOUND — check field names in vtAccountMetrics"}`);
  console.log(`   balance: ${m.balance != null ? "$" + m.balance.toFixed(2) : "⚠️ NOT FOUND — check field names in vtAccountMetrics"}`);
  if (m.equity == null || m.balance == null) {
    console.log(`   raw metrics keys: ${Object.keys(m.raw ?? {}).join(", ") || "(empty)"}`);
  }

  console.log("\n2) Positions...");
  const positions = await vtPositions();
  console.log(`   open positions: ${positions.length}`);
  if (positions.length) {
    const p = positions[0];
    console.log(`   first position keys: ${Object.keys(p).join(", ")}`);
  }

  if (PLACE_ORDER) {
    console.log("\n3) Stop order round-trip (place far-from-market, then cancel)...");
    const eq = m.equity ?? 100000;
    // A sell-stop at ~50% below any plausible price on minimal size — must never fill.
    const testQty = 0.1;
    const testStop = 1; // $1 stop on SOL — placement validity test only
    const orderCode = await vtPlaceStopOrder("sell", testQty, testStop);
    console.log(`   placed stop order: ${orderCode}`);
    await vtCancelOrder(orderCode);
    console.log(`   cancelled: ${orderCode}`);
    console.log(`   (account equity unchanged: $${eq.toFixed(2)})`);
  } else {
    console.log("\n3) Skipped order round-trip (pass --order to test on DEMO).");
  }

  console.log("\n✅ Self-test complete.");
} catch (err) {
  console.error(`\n❌ Self-test failed: ${err.message}`);
  process.exit(1);
}
