"""The idea backlog — mechanism-first crypto edge hypotheses.

This is the fuel the Validation Gauntlet burns. Every entry names *who is forced
to trade against you and why* — if you can't state that, it's a curve fit, not an
edge, and it doesn't belong here.

Each idea is scored 1-5 on six dimensions and ranked by their product, so a
single fatal weakness (e.g. data you can't get, or an edge only a colocated fund
can execute) tanks the idea the way it should. Work the top of the list first.

Scoring dimensions (1 = poor, 5 = excellent):
  mechanism_strength  how clearly a forced/non-economic counterparty exists
  capacity            how much size the edge can absorb before it moves the price
  executability       can *retail* actually run it (infra, latency, skill)
  data_availability   how cheap/easy the required data is to obtain
  independence        how uncorrelated it is with a generic long-crypto book
  durability          how slowly it should decay (inverse crowding/arms-race risk)

These are priors — deliberately humble starting guesses. The gauntlet, not this
table, decides what's real. Update scores as evidence arrives.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from math import prod


@dataclass(frozen=True)
class EdgeIdea:
    id: str
    name: str
    category: str            # structural | behavioral | carry | cross-sectional | microstructure | event | flow
    hypothesis: str
    mechanism: str           # who is forced to trade against you, and why
    data_source: str
    instruments: str
    timeframe: str
    how_to_test: str
    mechanism_strength: int
    capacity: int
    executability: int
    data_availability: int
    independence: int
    durability: int
    notes: str = ""

    @property
    def scores(self) -> dict[str, int]:
        return {
            "mechanism": self.mechanism_strength,
            "capacity": self.capacity,
            "executability": self.executability,
            "data": self.data_availability,
            "independence": self.independence,
            "durability": self.durability,
        }

    @property
    def priority(self) -> int:
        """Product of the six 1-5 scores (max 15625). Higher = work it sooner."""
        return prod(self.scores.values())

    @property
    def score100(self) -> float:
        return round(self.priority / (5 ** 6) * 100, 1)


# --------------------------------------------------------------------------- #
# The backlog. Concrete, crypto, mechanism-first.                             #
# --------------------------------------------------------------------------- #
BACKLOG: list[EdgeIdea] = [
    EdgeIdea(
        id="funding-carry",
        name="Perpetual funding carry (delta-neutral)",
        category="carry",
        hypothesis="Long spot / short perp harvests positive funding with little price risk.",
        mechanism="Over-leveraged directional longs must PAY funding to keep perps open; "
                  "the delta-neutral carry trader collects it as the forced counterparty.",
        data_source="Exchange funding-rate history + spot & perp prices (ccxt).",
        instruments="BTC, ETH, top perps + their spot",
        timeframe="8h funding cycle; hold days-weeks",
        how_to_test="Backtest funding minus borrow/fees; net of the spread paid to stay neutral. "
                    "Watch for negative-funding regimes and exchange counterparty risk.",
        mechanism_strength=5, capacity=5, executability=3,
        data_availability=5, independence=5, durability=4,
        notes="Crowded but structurally persistent; edge is in venue/fee optimization and sizing.",
    ),
    EdgeIdea(
        id="funding-extreme-fade",
        name="Funding-extreme directional fade",
        category="behavioral",
        hypothesis="Extreme positive funding flags crowded longs vulnerable to a squeeze; fade it.",
        mechanism="Late crowded longs pay ever-higher funding; when they can't, forced "
                  "deleveraging cascades. You fade the crowd before the unwind.",
        data_source="Funding-rate history + price (ccxt).",
        instruments="BTC, ETH, liquid alt perps",
        timeframe="Signal on 8h funding; hold hours-days",
        how_to_test="Rank funding percentile; short top decile / long bottom decile; "
                    "gauntlet with regime split (trending vs ranging).",
        mechanism_strength=4, capacity=4, executability=4,
        data_availability=5, independence=4, durability=3,
    ),
    EdgeIdea(
        id="liq-cascade-fade",
        name="Liquidation-cascade fade",
        category="microstructure",
        hypothesis="Forced liquidations overshoot; provide liquidity into the wick and fade.",
        mechanism="Liquidation engines fire MARKET orders regardless of price — the textbook "
                  "forced, price-insensitive counterparty. Their impact overshoots fair value.",
        data_source="Liquidation WebSocket (Binance/Bybit) + order book.",
        instruments="BTC, ETH perps",
        timeframe="Seconds-minutes",
        how_to_test="Event study around liq spikes; measure reversion vs adverse selection. "
                    "Model fills honestly — you're providing liquidity in a fast market.",
        mechanism_strength=5, capacity=2, executability=2,
        data_availability=3, independence=4, durability=3,
        notes="Strongest mechanism on the list but low capacity & execution-hard; automate or skip.",
    ),
    EdgeIdea(
        id="cash-and-carry",
        name="Dated-futures basis (cash-and-carry)",
        category="carry",
        hypothesis="Quarterly futures trade above spot; long spot / short future collects basis to expiry.",
        mechanism="Leveraged longs bid dated futures to a premium; the arbitrageur locks the "
                  "convergence they're forced to eventually give back at settlement.",
        data_source="Dated-futures + spot prices (Binance/OKX/Deribit).",
        instruments="BTC, ETH quarterly futures",
        timeframe="Hold weeks to expiry",
        how_to_test="Annualize basis, subtract fees/spread; compare to funding carry; check "
                    "backwardation regimes and margin requirements.",
        mechanism_strength=5, capacity=5, executability=3,
        data_availability=4, independence=5, durability=4,
    ),
    EdgeIdea(
        id="oi-price-divergence",
        name="Open-interest / price divergence",
        category="behavioral",
        hypothesis="Price up on rising OI (new longs) is fragile; price up on falling OI "
                   "(short covering) is durable. Trade the implied fragility.",
        mechanism="New leveraged longs are weak hands forced out on the next dip; short "
                  "covering removes forced buyers. OI reveals which is which.",
        data_source="Open-interest history + price (ccxt / exchange APIs).",
        instruments="BTC, ETH, liquid perps",
        timeframe="1h-4h",
        how_to_test="Classify bars by sign(ΔOI)×sign(Δprice); test forward returns per quadrant; "
                    "gauntlet for robustness.",
        mechanism_strength=3, capacity=4, executability=4,
        data_availability=4, independence=4, durability=3,
    ),
    EdgeIdea(
        id="xs-reversal",
        name="Cross-sectional short-term reversal",
        category="cross-sectional",
        hypothesis="Over 1-3 days, biggest movers in a perp universe over-extend and revert.",
        mechanism="Retail chases short-term winners and dumps losers (overreaction); you "
                  "provide liquidity to the overreaction and get paid the reversal.",
        data_source="OHLCV for a universe of ~30-50 perps (ccxt).",
        instruments="Basket of liquid alt perps",
        timeframe="1-3 day rebalance",
        how_to_test="Rank N-day returns; long bottom decile / short top decile, market-neutral; "
                    "gauntlet with turnover & cost stress (this one trades a lot).",
        mechanism_strength=4, capacity=4, executability=4,
        data_availability=5, independence=4, durability=3,
        notes="Naturally diversified across names; cost-sensitive.",
    ),
    EdgeIdea(
        id="xs-momentum",
        name="Cross-sectional momentum (perp basket)",
        category="cross-sectional",
        hypothesis="Over weeks, relative winners keep winning due to under-reaction and flow.",
        mechanism="Slow institutional/allocator flows under-react to trends; you front-run the "
                  "adjustment they're structurally slow to complete.",
        data_source="OHLCV universe (ccxt).",
        instruments="Basket of liquid perps",
        timeframe="Weekly rebalance",
        how_to_test="Rank trailing returns; long top / short bottom, vol-scaled; gauntlet with "
                    "regime split (momentum dies in choppy regimes).",
        mechanism_strength=3, capacity=4, executability=4,
        data_availability=5, independence=3, durability=3,
        notes="Correlated with generic trend-following; watch independence.",
    ),
    EdgeIdea(
        id="funding-timestamp",
        name="Funding-settlement timestamp effect",
        category="structural",
        hypothesis="Positioning reshuffles predictably right around funding settlement (00/08/16 UTC).",
        mechanism="Traders mechanically dodge paying / angle to collect funding at the snapshot, "
                  "forcing flow into fixed clock times independent of price.",
        data_source="Minute OHLCV (ccxt) — cheap.",
        instruments="BTC, ETH perps",
        timeframe="Minutes around 00/08/16 UTC",
        how_to_test="Event study on returns in the N minutes pre/post settlement; tiny but clean; "
                    "gauntlet with strict cost modelling.",
        mechanism_strength=4, capacity=3, executability=4,
        data_availability=5, independence=5, durability=3,
        notes="Cheap to test, highly independent — good early win to validate the pipeline.",
    ),
    EdgeIdea(
        id="session-effects",
        name="Time-of-day / session effects",
        category="structural",
        hypothesis="Liquidity and drift cluster around Asia/EU/US sessions and CME open/close.",
        mechanism="Mechanical rebalancers, CME arb, and regional liquidity create repeatable "
                  "intraday patterns tied to the clock, not to price.",
        data_source="Hourly/minute OHLCV (ccxt) — cheap.",
        instruments="BTC, ETH",
        timeframe="Intraday (hourly buckets)",
        how_to_test="Bucket returns by UTC hour & weekday; test stability across years; "
                    "gauntlet with walk-forward (patterns drift as market matures).",
        mechanism_strength=3, capacity=3, executability=5,
        data_availability=5, independence=4, durability=2,
        notes="Easiest to test end-to-end; decays as market matures, so re-validate often.",
    ),
    EdgeIdea(
        id="cme-gap",
        name="CME weekend gap fill (BTC)",
        category="behavioral",
        hypothesis="BTC gaps between Friday CME close and Sunday/Monday reopen tend to fill.",
        mechanism="Spot trades 24/7 while CME is shut; on reopen, basis arbitrageurs are forced "
                  "to reconcile CME to spot, pulling price back through the gap.",
        data_source="CME BTC futures + spot (Nasdaq Data Link / exchange).",
        instruments="BTC",
        timeframe="Weekend → early week",
        how_to_test="Measure gap-fill rate & time-to-fill vs gap size; account for gaps that "
                    "never fill (tail risk); gauntlet.",
        mechanism_strength=3, capacity=4, executability=4,
        data_availability=3, independence=4, durability=3,
    ),
    EdgeIdea(
        id="exchange-netflow",
        name="Exchange netflow (on-chain) signal",
        category="flow",
        hypothesis="Large net inflows to exchanges precede selling; net outflows precede holding.",
        mechanism="Whales must move coins onto an exchange before they can sell — an on-chain "
                  "tell that leaks intent before the market order lands.",
        data_source="On-chain analytics (CryptoQuant / Glassnode / Arkham) — paid.",
        instruments="BTC, ETH, major tokens",
        timeframe="Daily",
        how_to_test="Netflow z-score vs forward returns; beware look-ahead in provider data; "
                    "gauntlet with strict point-in-time discipline.",
        mechanism_strength=3, capacity=4, executability=3,
        data_availability=2, independence=4, durability=3,
        notes="Noisy and data is paid/lagged; treat provider timestamps skeptically.",
    ),
    EdgeIdea(
        id="stablecoin-supply",
        name="Stablecoin supply / mint impulse",
        category="flow",
        hypothesis="Net USDT/USDC mints add dry powder and precede spot inflows.",
        mechanism="Issuers mint to meet incoming fiat demand; that buying power is committed "
                  "before it reaches the order book — a slow structural lead.",
        data_source="On-chain mint/burn events (Etherscan/Tron/CryptoQuant).",
        instruments="BTC, ETH (market beta)",
        timeframe="Daily-weekly (macro)",
        how_to_test="Aggregate net mint; test lead-lag vs market returns; low frequency so guard "
                    "against tiny sample; gauntlet.",
        mechanism_strength=3, capacity=5, executability=3,
        data_availability=3, independence=3, durability=3,
    ),
    EdgeIdea(
        id="cross-venue-funding",
        name="Cross-venue funding / premium dislocation",
        category="carry",
        hypothesis="The same perp's funding/premium differs across exchanges; trade the spread.",
        mechanism="Fragmented liquidity means one venue's crowded positioning isn't instantly "
                  "arbitraged; the richer-funding venue's longs pay the poorer venue's shorts.",
        data_source="Funding & premium across 3-4 venues (ccxt).",
        instruments="BTC, ETH perps across Binance/Bybit/OKX",
        timeframe="8h; hold hours-days",
        how_to_test="Spread of funding across venues; go short-rich/long-cheap delta-neutral; "
                    "model transfer/withdrawal frictions honestly.",
        mechanism_strength=4, capacity=4, executability=3,
        data_availability=4, independence=5, durability=3,
    ),
    EdgeIdea(
        id="stable-depeg",
        name="Stablecoin depeg reversion",
        category="event",
        hypothesis="Temporary depegs in well-backed stables revert to $1.",
        mechanism="Panic redeemers dump below peg into thin liquidity; if backing is intact, "
                  "arbitrage forces convergence back to par.",
        data_source="Stablecoin spot prices + reserve/attestation signals.",
        instruments="USDC, USDT, DAI pairs",
        timeframe="Event-driven (hours-days)",
        how_to_test="Historical depeg episodes; size for the tail where a depeg is terminal; "
                    "this is a sell-insurance profile — gauntlet plus explicit ruin analysis.",
        mechanism_strength=4, capacity=4, executability=3,
        data_availability=3, independence=5, durability=4,
        notes="Fat left tail (a real de-peg = ruin). Position sizing matters more than signal.",
    ),
    EdgeIdea(
        id="vol-risk-premium",
        name="Options volatility risk premium",
        category="carry",
        hypothesis="Implied vol exceeds realized on average; systematically sell premium.",
        mechanism="Hedgers and lottery-ticket buyers over-pay for optionality; the seller "
                  "collects the structural premium they're willing to overpay.",
        data_source="Deribit options chain (implied vol) + realized vol.",
        instruments="BTC, ETH options",
        timeframe="Weekly expiries",
        how_to_test="IV-minus-RV spread; delta-hedged short-vol backtest; gauntlet plus tail/ruin "
                    "analysis (short vol blows up in crashes).",
        mechanism_strength=4, capacity=4, executability=2,
        data_availability=3, independence=4, durability=4,
        notes="Highest skill/infra barrier; negative skew — respect the tail.",
    ),
    EdgeIdea(
        id="listing-drift",
        name="Post-listing drift (major exchange)",
        category="event",
        hypothesis="Tokens newly listed on a major exchange show predictable early flow/drift.",
        mechanism="A Binance/Coinbase listing forces index funds, market makers, and FOMO retail "
                  "into a fixed window of demand around a scheduled event.",
        data_source="Listing announcements calendar + OHLCV.",
        instruments="Newly listed tokens",
        timeframe="Hours-days around listing",
        how_to_test="Event study on returns pre/post announcement & listing; small sample so "
                    "beware overfitting; gauntlet.",
        mechanism_strength=3, capacity=2, executability=3,
        data_availability=3, independence=4, durability=2,
    ),
]


def ranked(backlog: list[EdgeIdea] | None = None) -> list[EdgeIdea]:
    """Backlog sorted by priority (highest first)."""
    return sorted(backlog or BACKLOG, key=lambda e: e.priority, reverse=True)


def to_dataframe(backlog: list[EdgeIdea] | None = None):
    """Return the ranked backlog as a pandas DataFrame."""
    import pandas as pd
    rows = []
    for e in ranked(backlog):
        rows.append({
            "rank_score": e.score100, "id": e.id, "name": e.name,
            "category": e.category, **e.scores,
            "instruments": e.instruments, "data_source": e.data_source,
        })
    return pd.DataFrame(rows)


def seed_journal(journal, backlog: list[EdgeIdea] | None = None) -> list[int]:
    """Log every idea into the research journal at stage='idea'. Returns row ids."""
    ids = []
    for e in ranked(backlog):
        ids.append(journal.log(
            name=e.id, market="crypto", hypothesis=e.hypothesis, mechanism=e.mechanism,
            params={"category": e.category, "timeframe": e.timeframe, **e.scores},
            n_trials=0, stage="idea", verdict="hold",
            notes=f"[{e.score100}] {e.name} | data: {e.data_source} | {e.how_to_test}",
        ))
    return ids


def render_markdown(backlog: list[EdgeIdea] | None = None) -> str:
    """Human-readable ranked backlog table + detail cards."""
    items = ranked(backlog)
    lines = [
        "# Edge Machine — Crypto Idea Backlog",
        "",
        "> Auto-generated from `edgemachine/backlog.py` (the source of truth). "
        "Ranked by the product of six 1-5 priors; the **gauntlet**, not this table, "
        "decides what's real. Work the top down.",
        "",
        "Scores: **M**echanism · **C**apacity · **E**xecutability · "
        "**D**ata · **I**ndependence · Dura**b**ility (1 poor → 5 excellent).",
        "",
        "| # | Score | Idea | Category | M | C | E | D | I | b |",
        "|--:|--:|---|---|:-:|:-:|:-:|:-:|:-:|:-:|",
    ]
    for i, e in enumerate(items, 1):
        s = e.scores
        lines.append(
            f"| {i} | {e.score100} | {e.name} | {e.category} | "
            f"{s['mechanism']} | {s['capacity']} | {s['executability']} | "
            f"{s['data']} | {s['independence']} | {s['durability']} |"
        )
    lines += ["", "---", "", "## Detail cards", ""]
    for i, e in enumerate(items, 1):
        lines += [
            f"### {i}. {e.name}  ·  score {e.score100}  ·  `{e.id}`",
            f"- **Category:** {e.category}  |  **Instruments:** {e.instruments}  |  "
            f"**Timeframe:** {e.timeframe}",
            f"- **Hypothesis:** {e.hypothesis}",
            f"- **Mechanism (who loses & why):** {e.mechanism}",
            f"- **Data:** {e.data_source}",
            f"- **How to test:** {e.how_to_test}",
        ]
        if e.notes:
            lines.append(f"- **Notes:** {e.notes}")
        lines.append("")
    return "\n".join(lines)
