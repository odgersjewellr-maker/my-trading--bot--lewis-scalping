"""
Minimal local stand-in for Binance's public REST endpoints, for running
`freqtrade backtesting`/`hyperopt` in a network-restricted environment (CI,
sandboxes) where real exchange APIs are unreachable but local OHLCV data is
already present under user_data/data/.

Freqtrade always calls exchange.reload_markets() before backtesting, even
against local data, to fetch trading-pair metadata (precision, min notional,
lot size). This server answers that call with static, valid-shaped BTCUSDT
metadata so the offline pipeline can run end-to-end. It does NOT proxy real
market data, prices, or orders — do not point live/dry-run trading at it.

Usage:
    python3 tools/offline_exchange_mock.py &

Then point ccxt at it via config's exchange.ccxt_config / ccxt_async_config,
e.g. (see freqtrade docs for the full urls.api key list):

    {
      "urls": {"api": {
        "public": "http://127.0.0.1:8899/api/v3",
        "private": "http://127.0.0.1:8899/api/v3",
        "fapiPublic": "http://127.0.0.1:8899/fapi/v1",
        "fapiPrivate": "http://127.0.0.1:8899/fapi/v1",
        "dapiPublic": "http://127.0.0.1:8899/dapi/v1",
        "dapiPrivate": "http://127.0.0.1:8899/dapi/v1",
        "eapiPublic": "http://127.0.0.1:8899/eapi/v1",
        "eapiPrivate": "http://127.0.0.1:8899/eapi/v1",
        "sapi": "http://127.0.0.1:8899/sapi/v1"
      }}
    }

On a machine with real internet access to Binance, skip this entirely and
just run `freqtrade backtesting` / `freqtrade download-data` normally.
"""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

def _symbol_entry(symbol: str, base_asset: str) -> dict:
    return {
        "symbol": symbol,
        "status": "TRADING",
        "baseAsset": base_asset,
        "baseAssetPrecision": 8,
        "quoteAsset": "USDT",
        "quotePrecision": 8,
        "quoteAssetPrecision": 8,
        "baseCommissionPrecision": 8,
        "quoteCommissionPrecision": 8,
        "orderTypes": ["LIMIT", "MARKET", "LIMIT_MAKER", "STOP_LOSS_LIMIT", "TAKE_PROFIT_LIMIT"],
        "icebergAllowed": True,
        "ocoAllowed": True,
        "otoAllowed": False,
        "quoteOrderQtyMarketAllowed": True,
        "allowTrailingStop": True,
        "cancelReplaceAllowed": True,
        "isSpotTradingAllowed": True,
        "isMarginTradingAllowed": True,
        "filters": [
            {"filterType": "PRICE_FILTER", "minPrice": "0.01000000", "maxPrice": "1000000.00000000", "tickSize": "0.01000000"},
            {"filterType": "LOT_SIZE", "minQty": "0.00001000", "maxQty": "9000.00000000", "stepSize": "0.00001000"},
            {"filterType": "MARKET_LOT_SIZE", "minQty": "0.00000000", "maxQty": "100.00000000", "stepSize": "0.00000000"},
            {"filterType": "NOTIONAL", "minNotional": "5.00000000", "applyMinToMarket": True, "maxNotional": "9000000.00000000", "applyMaxToMarket": False, "avgPriceMins": 5},
            {"filterType": "ICEBERG_PARTS", "limit": 10},
            {"filterType": "MAX_NUM_ORDERS", "maxNumOrders": 200},
            {"filterType": "MAX_NUM_ALGO_ORDERS", "maxNumAlgoOrders": 5},
        ],
        "permissions": [],
        "permissionSets": [["SPOT", "MARGIN"]],
        "defaultSelfTradePreventionMode": "NONE",
        "allowedSelfTradePreventionModes": ["NONE", "EXPIRE_TAKER"],
    }


EXCHANGE_INFO = {
    "timezone": "UTC",
    "serverTime": 1714003200000,
    "rateLimits": [],
    "exchangeFilters": [],
    "symbols": [
        _symbol_entry("BTCUSDT", "BTC"),
        _symbol_entry("ETHUSDT", "ETH"),
    ],
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        if self.path.startswith("/api/v3/exchangeInfo"):
            body = json.dumps(EXCHANGE_INFO).encode()
        elif self.path.startswith("/api/v3/time"):
            body = json.dumps({"serverTime": 1714003200000}).encode()
        elif self.path.startswith("/api/v3/ticker/price"):
            body = json.dumps({"symbol": "BTCUSDT", "price": "65000.00"}).encode()
        elif "exchangeInfo" in self.path:
            # fapi/dapi/eapi variants: no futures/options/margin markets needed.
            body = json.dumps({"timezone": "UTC", "serverTime": 1714003200000, "symbols": []}).encode()
        else:
            body = json.dumps({}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8899), Handler)
    print("Offline exchange mock listening on http://127.0.0.1:8899")
    server.serve_forever()
