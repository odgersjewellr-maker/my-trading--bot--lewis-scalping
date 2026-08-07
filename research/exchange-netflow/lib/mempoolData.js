/**
 * Free, keyless Bitcoin on-chain data via mempool.space's public API.
 * Fetches confirmed transaction history for a watched address and derives
 * the net BTC flow into/out of it per transaction.
 */
const MEMPOOL = "https://mempool.space/api";

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mempool.space request failed: ${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

/** Net BTC flow for one address across one tx: +ve = address received more than it sent (inflow). */
function netFlowForAddress(tx, address) {
  const received = tx.vout.filter((o) => o.scriptpubkey_address === address).reduce((s, o) => s + o.value, 0);
  const sent = tx.vin
    .filter((i) => i.prevout?.scriptpubkey_address === address)
    .reduce((s, i) => s + i.prevout.value, 0);
  return (received - sent) / 1e8; // sats -> BTC
}

/**
 * Confirmed-only flow events for one address, oldest -> newest, going
 * back roughly `days`. Unconfirmed (mempool) transactions are excluded —
 * they don't have a reliable timestamp for historical alignment.
 */
async function fetchAddressFlowEvents(address, days) {
  const cutoffSec = (Date.now() - days * 24 * 60 * 60 * 1000) / 1000;
  const events = [];
  let url = `${MEMPOOL}/address/${address}/txs`;
  let lastTxid = null;

  while (true) {
    const batch = await getJson(url);
    if (!batch.length) break;

    const confirmed = batch.filter((tx) => tx.status?.confirmed);
    for (const tx of confirmed) {
      if (tx.status.block_time < cutoffSec) continue;
      events.push({
        time: tx.status.block_time * 1000,
        amount: netFlowForAddress(tx, address),
      });
    }

    const oldestInBatch = confirmed.length ? confirmed[confirmed.length - 1] : null;
    if (!oldestInBatch || oldestInBatch.status.block_time < cutoffSec || batch.length < 25) break;

    lastTxid = batch[batch.length - 1].txid;
    url = `${MEMPOOL}/address/${address}/txs/chain/${lastTxid}`;
    await new Promise((r) => setTimeout(r, 200));
  }

  return events;
}

/** Combined flow events across all watched wallets, oldest -> newest. */
export async function fetchExchangeFlowEvents(wallets, days) {
  const all = [];
  for (const w of wallets) {
    const events = await fetchAddressFlowEvents(w.address, days);
    for (const e of events) all.push({ ...e, wallet: w.label });
  }
  return all.sort((a, b) => a.time - b.time);
}
