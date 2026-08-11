/**
 * Relay configuration — matches the Searchstr/UNCAGED ecosystem plus
 * Indexstr's own publish set.
 *
 * Index observations (SIP-01, kind 39697) are published to:
 * 1. The NIP-50 search relay pool (so search engines see them immediately)
 * 2. Public write relays (so they replicate widely)
 */

/**
 * Relays that support NIP-50 search queries.
 * Same defaults as UNCAGED-ENGINE / 0xSearchstr.
 */
export const SEARCH_RELAYS = [
  'wss://relay.nostr.band/',
  'wss://relay.ditto.pub/',
  'wss://search.nos.today/',
  'wss://relay.noswhere.com/',
];

/**
 * Relays that index observations are published to. NIP-50 search relays that
 * accept writes come first (so the Web Index provider sees fresh observations
 * immediately), then general write relays so they replicate widely.
 *
 * Note: wss://search.nos.today/ is deliberately absent — it answers every
 * write with "blocked: writes disabled". It stays in SEARCH_RELAYS (reading)
 * but can never accept an observation.
 */
export const INDEX_WRITE_RELAYS = [
  'wss://relay.nostr.band/',
  'wss://relay.ditto.pub/',
  'wss://relay.noswhere.com/',
  'wss://relay-na1.metanomalist.com/',
  'wss://jskitty.cat/nostr',
  'wss://relay.primal.net/',
  'wss://relay.damus.io/',
  'wss://nostr.hifish.org/',
  // Tor-only relay. Reachable from Tor Browser, where .onion is a secure
  // context so plain ws:// is fine (the Tor circuit provides the encryption).
  // On clearnet browsers the hostname never resolves and the connection is
  // skipped by the pool — harmless to include.
  'ws://acuy3mjnv26tkyaaucndlxmg2ocntz4rtebhavk57vgruozm42iaznqd.onion/',
];

/**
 * Relays that index observations are published to. Indexstr is a pure
 * publisher, so this is exactly the write set (deduped).
 */
export function getIndexPublishRelays(): string[] {
  return [...new Set(INDEX_WRITE_RELAYS)];
}
