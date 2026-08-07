# LLM Forecast — forward-only prediction logger

**Status: research only. Not wired into `bot.js`, `rules.json`, or live execution. Nothing here places an order.**

Third research track. Different from `causal-fusion/` and `stablecoin-flow/` in a fundamental way: those are statistical models you can backtest against history. **This one cannot be backtested at all.** It asks Claude directly to read a market snapshot and predict direction — and Claude's training data includes historical crypto prices up to its knowledge cutoff. Testing it against historical bars would let it "predict" things it may have simply memorized. That's not a hypothetical risk, it's a well-documented contamination problem with this exact kind of test.

So this module only ever logs predictions about the future, before the outcome exists, and scores them once real time has actually passed. There is no shortcut around that — the log starts empty and has to fill in for real.

## How it works

1. `predict.js` (single symbol) or `predict-batch.js` (a whole watchlist) builds a snapshot of current market state and asks Claude (via the real Claude API, not Claude Code) for a direction, a calibrated confidence, and a rationale — returned as structured tool output, not free text.
2. The prediction is appended to `log/predictions.jsonl` with a timestamp and a resolution time (`now + horizon`).
3. Later, once that time has passed, `score.js` fetches what actually happened and marks the prediction correct/incorrect.
4. Run `score.js` again any time to see the running scorecard.
5. Once there are 30+ resolved predictions, `reflect.js` reviews them and writes `log/playbook.md` — a self-critique that gets fed back into every future prediction's prompt (step 1) as extra context.

## "Self-learning" — what this actually is and isn't

**Claude's weights never change.** There's no fine-tuning loop here, and none is available for this use case. What `reflect.js` does is genuinely different from that: it has Claude review its own resolved predictions (what it called, how confident it was, what actually happened) and write itself a short critique, which gets prepended to future prompts. That's in-context self-critique, not learning — closer to a trader re-reading their own trade journal before the next session than to a model being retrained.

It's gated behind **30 minimum resolved predictions** on purpose. Below that, "patterns" found in the data are much more likely to be coincidence than signal, and a confidently-written playbook based on noise is worse than no playbook — it launders randomness into something that reads like earned wisdom. `reflect.js` refuses to run below the threshold rather than produce that.

Run `reflect.js` occasionally (weekly is plenty) — it reviews everything resolved so far each time, so running it more often just re-spends money re-deriving the same conclusions from a barely-larger sample.

## Running on multiple tickers

`predict-batch.js` loops a watchlist in one invocation — the intended cron entry point instead of scheduling `predict.js` separately per symbol. Default watchlist is `BTCUSDT,ETHUSDT,SOLUSDT`, overridable via a CLI arg or the `WATCHLIST` env var.

Worth knowing before widening it further: crypto assets are highly correlated (BTC-beta) — adding another 10 altcoins doesn't give you 10x independent evidence, it mostly gives correlated repeats of the same market move, while cost scales exactly linearly with watchlist size (each symbol is a separate billed call). A small, deliberately-composed watchlist beats a wide one here.

## What data goes into each snapshot

Per your question — yes to all of it:

| Category | Specifically |
|---|---|
| Price shape | Last 30 hourly bars: close, volume, taker-buy-delta |
| Trend | EMA(8), EMA(21) — same EMA(8) definition as `rules.json` |
| Momentum | RSI(3), RSI(14) — RSI(3) matches `rules.json`'s scalping signal |
| Volume-weighted level | Rolling 24h VWAP (a trailing approximation, not the live bot's midnight-reset session VWAP) |
| Order flow | Taker-buy/sell delta per bar, plus a 12-bar rolling average (flow persistence) |
| Liquidity | Live order book: best bid/ask, spread %, top-20-level bid/ask imbalance |
| Positioning | Latest funding rate, current open interest |

All free, live, keyless-except-liquidity Binance USDT-M futures data — no historical fetching needed since every prediction only cares about "right now."

## Setup

Needs a **paid** Anthropic API key (this is the one module in this repo that costs money to run):

1. Get a key at https://console.anthropic.com/
2. Add to `.env`: `ANTHROPIC_API_KEY=your_key_here`
3. Optionally set `LLM_FORECAST_MODEL` — defaults to `claude-sonnet-5`. `claude-haiku-4-5-20251001` is cheaper if you're running this often and cost adds up.

## Running it

```bash
npm install
node research/llm-forecast/predict-batch.js         # log a prediction for BTCUSDT, ETHUSDT, SOLUSDT
node research/llm-forecast/predict.js SOLUSDT 4      # or just one symbol
node research/llm-forecast/score.js                  # resolve due predictions + print scorecard
node research/llm-forecast/reflect.js                # once 30+ resolved — writes the self-critique playbook
```

**Run `predict.js`/`predict-batch.js` on a schedule (every 4-6h), not every bar.** Each call is billed. It's also the only sane cadence anyway — running it hourly against a 4h horizon just produces heavily overlapping, correlated predictions that inflate your sample count without adding real independent evidence. A crontab line matching the main bot's pattern:

```
0 */4 * * * cd /root/bot && /usr/bin/node research/llm-forecast/predict-batch.js >> llm-forecast.log 2>&1
0 5 * * 0   cd /root/bot && /usr/bin/node research/llm-forecast/reflect.js >> llm-forecast.log 2>&1   # weekly
```

`score.js` is free to run as often as you like — it only reads price data.

## Reading the scorecard honestly

- **Under 30 resolved directional predictions, don't conclude anything.** The script says so explicitly. 100+ is where it starts being informative.
- **Compare accuracy to the 50% coin-flip baseline, not to 0%.** Anything meaningfully above 50% sustained over a real sample is the bar to clear — and even that only means "better than random," not "profitable after fees and slippage."
- **Check the calibration line** (avg confidence when correct vs when wrong). If they're close together, the model's stated confidence isn't tracking real accuracy, and you shouldn't size positions by it even if directional accuracy looks decent.
- **"flat" predictions are excluded from accuracy** — they're logged as abstentions, not as a third outcome to be scored right/wrong.

## Files

| File | Purpose |
|---|---|
| `lib/binanceSnapshot.js` | Live klines, order book, funding, OI — always "right now", no history |
| `lib/indicators.js` | EMA, RSI, rolling VWAP, taker-delta |
| `lib/buildPrompt.js` | Pure function assembling the snapshot text (no network — testable in isolation) |
| `lib/llmClient.js` | Calls the Claude API with forced structured tool output |
| `lib/logStore.js` | Append/read/rewrite for the JSONL prediction log |
| `lib/runPrediction.js` | Shared "predict one symbol" pipeline used by both `predict.js` and `predict-batch.js` — also where the playbook gets loaded and injected |
| `predict.js` | CLI — logs one new forward prediction for a single symbol |
| `predict-batch.js` | CLI — logs a forward prediction for a whole watchlist in one run |
| `score.js` | CLI — resolves due predictions, prints the scorecard |
| `reflect.js` | CLI — once 30+ resolved predictions exist, writes `log/playbook.md` |
| `log/predictions.jsonl` | The actual research artifact — **not gitignored, meant to be committed** as evidence accumulates |
| `log/playbook.md` | Generated by `reflect.js`; fed into future prompts. Also not gitignored — it's a record of what the self-critique loop concluded and when. |

## Note on this sandbox

`api.anthropic.com`, `fapi.binance.com`, and general Binance endpoints are proxy-blocked here, so this could only be validated offline: `indicators.js` was checked against the repo's real historical BTC price CSV, `buildPrompt.js` was checked for correct structure/bounds and correct playbook-section injection (present vs absent, correct ordering) with synthetic klines, and `logStore.js`'s append/read/resolve/rewrite cycle was round-tripped end to end. `reflect.js`'s minimum-sample gate was run for real against the empty log (0 resolved predictions) and correctly refused to call the API rather than reflect on nothing. `predict-batch.js` was run for real too — it correctly isolated the per-symbol failure (Binance blocked here) across all three watchlist symbols without one failure stopping the others. None of that touched a real Claude API call or real live Binance data — that first real run happens on your machine.

## Honest expectation-setting

Based on current research (see the earlier conversation): general-purpose LLMs reading raw price sequences as text tend to underperform models built specifically for numeric time-series forecasting, and financial returns are close enough to a random walk that no model has a high ceiling here regardless. I'd be surprised if this beats causal-fusion or mint-flow. The value of building it isn't a bet that it wins — it's that "does this work" stops being a guess and becomes a number you can look at after a few weeks of logging.
