/**
 * HyroTrader stop-lifecycle test — the one path hyrotrader-check.mjs can't
 * exercise (a protective stop is reduce-only, so it needs a live position).
 *
 * Runs the bot's exact entry sequence on the trial account with minimal size:
 *   1. market BUY 0.1 SOL (~$8 notional of demo funds)
 *   2. place protective sell-stop 5% below market  (bot does this on entry)
 *   3. amend the stop up 1% (the trailing-ratchet path)
 *   4. cancel the stop (position-close path)
 *   5. market SELL reduce-only to flatten
 *   6. verify flat + report P&L impact
 *
 * Total demo P&L impact: spread+fees on ~$8, i.e. cents.
 * Usage: node --env-file=hyrotrader/.env hyrotrader-stoptest.mjs
 */
import { htRaw, htAccountMetrics, htPositions, htPlaceMarketOrder, htPlaceStopOrder, htReplaceStopOrder, htSafeCancelStop } from "./hyrotrader.js";

const SYMBOL = process.env.SYMBOL || "SOLUSDT";
const QTY = "0.1";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = msg => { console.log(`\n❌ ${msg}`); process.exit(1); };

const eq0 = (await htAccountMetrics()).equity;
console.log(`Stop-lifecycle test on ${SYMBOL} — equity before: $${eq0.toFixed(2)}\n`);

// price context
const tick = await htRaw("GET", "/v5/market/tickers", { category: "linear", symbol: SYMBOL });
const last = parseFloat(tick?.list?.[0]?.lastPrice);
console.log(`1) market BUY ${QTY} ${SYMBOL} @ ~$${last.toFixed(2)}...`);
const { orderId: entryId } = await htPlaceMarketOrder("buy", QTY, "OPEN");
console.log(`   entry orderId ${entryId}`);
await sleep(1500);
let pos = (await htPositions()).find(p => Math.abs(parseFloat(p.size ?? 0)) > 0);
if (!pos) fail("position did not appear after market buy");
console.log(`   position open: ${pos.side} ${pos.size} @ avg ${pos.avgPrice}`);

console.log(`\n2) protective sell-stop 5% below market...`);
const stop1 = (last * 0.95).toFixed(2);
const stopId1 = await htPlaceStopOrder("sell", QTY, stop1);
if (!stopId1) fail("stop order returned no orderId");
console.log(`   stop placed @ $${stop1}: ${stopId1}`);

console.log(`\n3) trailing ratchet — amend stop up to 4% below...`);
const stop2 = (last * 0.96).toFixed(2);
const stopId2 = await htReplaceStopOrder(stopId1, "sell", QTY, stop2);
console.log(`   stop now @ $${stop2}: ${stopId2}${stopId2 === stopId1 ? " (amended in place ✓)" : " (recreated — amend fell back)"}`);

console.log(`\n4) cancel stop (position-close path)...`);
await htSafeCancelStop(stopId2);
console.log(`   cancelled ${stopId2}`);

console.log(`\n5) flatten — market SELL reduce-only...`);
const { orderId: exitId } = await htPlaceMarketOrder("sell", QTY, "CLOSE");
console.log(`   exit orderId ${exitId}`);
await sleep(1500);
pos = (await htPositions()).find(p => Math.abs(parseFloat(p.size ?? 0)) > 0);
if (pos) fail(`position still open after close: ${pos.side} ${pos.size}`);

const eq1 = (await htAccountMetrics()).equity;
console.log(`\n6) flat ✓ — equity after: $${eq1.toFixed(2)} (impact $${(eq1 - eq0).toFixed(2)})`);
console.log(`\n✅ FULL STOP LIFECYCLE VERIFIED: entry → stop → amend → cancel → close.`);
