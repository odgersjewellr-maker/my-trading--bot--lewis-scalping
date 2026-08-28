# CLAUDE.md

Guidance for Claude Code sessions working in this repo.

## What this is

An automated crypto scalping bot (`bot.js`) that trades BTC/SOL on live exchange
accounts (BitGet, plus Binance/Hyrotrader/Velotrade variants) using a
Neural Kernel Bands strategy (`neural-kernel-bands.pine`) and rule-based entry
conditions from `rules.json`. It is **not** an LLM-driven trading agent — Claude
is used to build/maintain the code, but trade decisions at runtime come from
the indicator logic in `bot.js`, not from a model call.

Multiple GitHub Actions workflows (`.github/workflows/*.yml`) run the bot on a
schedule (every ~15 min) against different symbol/mode combinations
(`BTCUSDT`, `SOLUSDT`, `-PROP`, `-CONFLUENCE`, `-DAILY` variants) and commit
the resulting state files straight to this branch. **Commits with messages
like "BTC run" / "SOL run" are automated bot output, not manual work** —
don't be surprised by a fast-moving history, and don't revert them without
checking they aren't just routine state snapshots.

## Safety-critical files — treat changes here as high-risk

These files gate real money movement. Changing them changes live trading
behavior, not just code style:

- `bot.js` — order placement, position sizing, entry/exit logic
- `rules.json` — the strategy's entry/exit conditions
- `.env` / `hyro-trial.env` / exchange-specific env vars — `PAPER_TRADING`,
  `MAX_TRADE_SIZE_USD`, `MAX_TRADES_PER_DAY`, `RISK_PCT`, `PROP_MAX_DD_PCT`,
  `PROP_DAILY_GUARD`, `PROP_DD_GUARD`, `LEVERAGE` — these are drawdown/risk
  guardrails, not arbitrary config. Loosening them is a deliberate risk
  decision, not a cleanup.
- `safety-check-log*.json` / `prop-state-*.json` / `position-*.json` /
  `portfolio-*.json` — auto-generated runtime state. Don't hand-edit; if they
  look wrong, fix what's writing them, not the file itself.

Before changing anything in `bot.js` or `rules.json`:

1. Run the relevant backtest first (`backtest.js`, `backtest12m.js`,
   `backtest-confluence.mjs`, `backtest-scaleout.mjs`) and check the change
   doesn't silently widen risk (bigger size, fewer safety checks, loosened
   drawdown guard).
2. If a live account is in `PAPER_TRADING=false` mode, prefer testing the
   change with `PAPER_TRADING=true` first rather than pushing straight to a
   live-trading path.
3. Never remove or bypass a risk guardrail (spend limit, daily trade cap,
   drawdown halt) to "fix" a bug — fix the bug within the guardrail instead.

## Secrets

Real credentials (`BITGET_API_KEY`, `BITGET_SECRET_KEY`, `BITGET_PASSPHRASE`,
and equivalents for other exchanges) belong only in `.env` / exchange-specific
`.env` files, which are gitignored. `hyro-trial.env` and `.env.example` are
tracked on purpose but contain only non-secret config (mode/risk parameters),
not keys — keep it that way; don't add real keys to a tracked file.

## Working with the automated commit history

This branch receives frequent automated commits from scheduled bot runs.
Before any destructive git operation (`reset --hard`, force-push, discarding
uncommitted changes), run `git status` and confirm you're not about to lose a
recent automated run's state update.
