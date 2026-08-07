/**
 * Read-only portfolio view combining causal-fusion, stablecoin-flow,
 * exchange-netflow, and llm-forecast into one confidence-weighted
 * position per symbol.
 *
 * Never places an order. Never calls the paid Claude API — llm-forecast's
 * signal here is read from its existing log (log/predictions.jsonl), not
 * freshly generated, so this is safe/free to run as often as you like.
 *
 * Usage:
 *   node research/combiner/report.js
 *   node research/combiner/report.js BTCUSDT SOLUSDT
 */
import "dotenv/config";
import { getCausalFusionSignal } from "./lib/signals/causalFusion.js";
import { getStablecoinFlowSignal } from "./lib/signals/stablecoinFlow.js";
import { getExchangeNetflowSignal } from "./lib/signals/exchangeNetflow.js";
import { getLlmForecastSignal } from "./lib/signals/llmForecast.js";
import { combineSignals } from "./lib/combine.js";

const argSymbols = process.argv.slice(2);
const SYMBOLS = argSymbols.length ? argSymbols : ["BTCUSDT", "SOLUSDT"];

async function reportSymbol(symbol) {
  console.log(`\n=== ${symbol} ===`);

  const [causalFusion, stablecoinFlow, exchangeNetflow] = await Promise.all([
    getCausalFusionSignal(symbol),
    getStablecoinFlowSignal(symbol),
    getExchangeNetflowSignal(symbol),
  ]);
  const llmForecast = getLlmForecastSignal(symbol); // sync — local log read only, no API call

  const signals = [causalFusion, stablecoinFlow, exchangeNetflow, llmForecast];
  for (const s of signals) {
    if (s.available) {
      console.log(`  ${s.name.padEnd(16)} ${s.direction.padEnd(6)} conviction=${s.conviction.toFixed(2)}  ${s.detail ?? ""}`);
    } else {
      console.log(`  ${s.name.padEnd(16)} unavailable — ${s.error}`);
    }
  }

  const portfolio = combineSignals(signals);
  console.log(`\n  PORTFOLIO: ${portfolio.direction} (conviction ${portfolio.conviction.toFixed(2)})`);
  for (const c of portfolio.contributions) {
    if (c.weight > 0) {
      console.log(`    ${c.name}: weight=${c.weight.toFixed(2)}  contribution=${c.contribution.toFixed(3)}`);
    } else {
      console.log(`    ${c.name}: ${c.note}`);
    }
  }
}

async function run() {
  for (const symbol of SYMBOLS) {
    try {
      await reportSymbol(symbol);
    } catch (err) {
      console.error(`${symbol} failed:`, err.message);
    }
  }
}

run();
