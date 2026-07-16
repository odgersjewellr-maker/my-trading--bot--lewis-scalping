/**
 * HyroTrader adapter self-test — run against the FREE TRIAL first.
 *
 * Usage:
 *   node --env-file=hyrotrader/.env hyrotrader-check.mjs           # read-only
 *   node --env-file=hyrotrader/.env hyrotrader-check.mjs --order   # + far-from-market limit round-trip
 *
 * Requires in the env file: HYROTRADER_API_KEY, HYROTRADER_API_SECRET
 * Optional: HYROTRADER_BASE_URL, HYROTRADER_ACCOUNT_TYPE, SYMBOL
 *
 * Prints NO api key, secret, or signature. Verifies the DEMO-VERIFY items in
 * hyrotrader.js: auth/signing works, wallet-balance field names resolve,
 * positions shape, instrument qtyStep, and (with --order) create + cancel on a
 * price that can never fill. The order test uses a NON-reduce limit far below
 * market, so it works on a flat demo account and never takes a real position.
 */
import { htRaw, htAccountMetrics, htPositions } from "./hyrotrader.js";

const PLACE_ORDER = process.argv.includes("--order");
const SYMBOL = process.env.SYMBOL || "SOLUSDT";
const mask = v => v == null ? "(not set)" : (String(v).length <= 4 ? "***" : `${String(v).slice(0, 2)}***${String(v).slice(-2)}`);

console.log("HyroTrader / Bybit adapter self-test");
console.log(`  Base URL:   ${process.env.HYROTRADER_BASE_URL || "https://api.bybit.com"}`);
console.log(`  API key:    ${mask(process.env.HYROTRADER_API_KEY)}`);
console.log(`  Acct type:  ${process.env.HYROTRADER_ACCOUNT_TYPE || "UNIFIED"}`);
console.log(`  Symbol:     ${SYMBOL}\n`);

try {
  console.log("1) Auth + account metrics...");
  const m = await htAccountMetrics();
  console.log(`   equity:  ${m.equity != null ? "$" + m.equity.toFixed(2) : "⚠️ NOT FOUND — check field names in htAccountMetrics"}`);
  console.log(`   balance: ${m.balance != null ? "$" + m.balance.toFixed(2) : "⚠️ NOT FOUND — check field names in htAccountMetrics"}`);
  if (m.equity == null || m.balance == null) console.log(`   raw keys: ${Object.keys(m.raw ?? {}).join(", ") || "(empty)"}`);

  console.log("\n2) Positions...");
  const positions = await htPositions();
  const open = positions.filter(p => Math.abs(parseFloat(p.size ?? 0)) > 0);
  console.log(`   position records: ${positions.length} | open: ${open.length}`);
  if (open.length) console.log(`   first open keys: ${Object.keys(open[0]).join(", ")}`);

  console.log("\n3) Instrument precision (qtyStep)...");
  const info = await htRaw("GET", "/v5/market/instruments-info", { category: "linear", symbol: SYMBOL });
  const lot = info?.list?.[0]?.lotSizeFilter ?? {};
  console.log(`   qtyStep ${lot.qtyStep ?? "?"} | minQty ${lot.minOrderQty ?? "?"}`);

  if (PLACE_ORDER) {
    console.log("\n4) Order round-trip (far-from-market limit that can never fill, then cancel)...");
    const tick = await htRaw("GET", "/v5/market/tickers", { category: "linear", symbol: SYMBOL });
    const last = parseFloat(tick?.list?.[0]?.lastPrice ?? "0");
    const price = (last * 0.5).toFixed(2);                 // 50% below market — will not fill
    // Bybit enforces a 5 USDT minimum ORDER VALUE (retCode 110094), so size the
    // probe above it: smallest step multiple with qty*price >= ~6 USDT.
    const step = parseFloat(lot.qtyStep ?? "0.1");
    const minQty = parseFloat(lot.minOrderQty ?? step);
    const needed = Math.max(minQty, Math.ceil((6 / parseFloat(price)) / step) * step);
    const qty = needed.toFixed((String(step).split(".")[1] || "").length);
    const created = await htRaw("POST", "/v5/order/create", {
      category: "linear", symbol: SYMBOL, side: "Buy", orderType: "Limit",
      qty: String(qty), price, timeInForce: "GTC", positionIdx: 0,
    });
    console.log(`   placed limit @ $${price} (last $${last.toFixed(2)}): orderId ${created?.orderId}`);
    await htRaw("POST", "/v5/order/cancel", { category: "linear", symbol: SYMBOL, orderId: created.orderId });
    console.log(`   cancelled: ${created.orderId}`);
    console.log(`   ✓ create + cancel + signing + precision all verified on the trial.`);
  } else {
    console.log("\n(read-only — pass --order to also test order create/cancel)");
  }
  console.log("\n✅ Reachable and authenticated. Review any ⚠️ above before a real challenge.");
} catch (err) {
  console.log(`\n❌ ${err.message}`);
  console.log("   Common trial fixes: set HYROTRADER_BASE_URL to the endpoint HyroTrader gave you;");
  console.log("   confirm ACCOUNT_TYPE (UNIFIED vs CONTRACT); check the API key has trade permission.");
  process.exit(1);
}
