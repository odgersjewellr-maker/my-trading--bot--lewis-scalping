/**
 * Curated, verified Bitcoin exchange wallet addresses.
 *
 * DELIBERATELY MINIMAL. This is one address, not a comprehensive exchange
 * netflow tracker. Commercial on-chain analytics products (Glassnode,
 * CryptoQuant) cluster hundreds of known addresses per exchange; building
 * and maintaining that kind of address list responsibly is a real ongoing
 * research effort, not something to fabricate from memory in one sitting.
 *
 * The address below was cross-checked against multiple independent
 * sources (bitinfocharts, coincarp, on-chain analytics citing it as
 * Binance's cold wallet, ~1.2% of all circulating BTC) rather than taken
 * from a single unverified source. Getting this wrong would be worse than
 * having no signal at all — a wrong address produces a netflow number
 * that looks legitimate but means nothing.
 *
 * To responsibly expand this list: cross-reference at least two
 * independent sources (e.g. coincarp.com's live-maintained exchange
 * wallet pages, walletexplorer.com) before adding an address, and prefer
 * addresses with long transaction history and exchange-consistent
 * behavior (many small inbound deposits) over anything unverified.
 */
export const BTC_EXCHANGE_WALLETS = [
  {
    label: "Binance Cold Wallet",
    address: "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo",
  },
];
