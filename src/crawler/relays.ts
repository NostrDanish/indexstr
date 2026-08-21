/**
 * Relay configuration — the Indexstr relay pool.
 *
 * Two views over the same pool:
 *   - getIndexPublishRelays(): where kind 39697 observations + kind 16919
 *     heartbeats are pushed (every relay, best-effort, health-gated)
 *   - getIndexReadRelays(): where the node reads network signals back
 *     (publish set + the NIP-50 search pool, incl. read-only nos.today)
 *
 * The pool is user-editable: Settings → Index Relay Pool. Overrides
 * (added/removed) persist in localStorage on this device; the crawler reads
 * the pool dynamically, so changes apply to the next publish/read cycle.
 */

/**
 * NIP-50-capable search relays (read side). search.nos.today rejects writes
 * ("blocked: writes disabled") — it is read-only here by design.
 */
export const SEARCH_RELAYS = [
  'wss://relay.nostr.band/',
  'wss://relay.ditto.pub/',
  'wss://search.nos.today/',
  'wss://relay.noswhere.com/',
];

export interface RelayCaps {
  /** SIP-01-aware indexing relay (validates/indexes observations). */
  sip01?: boolean;
  /** NIP-50 full-text search support. */
  nip50?: boolean;
  /** Rejects writes — read-only member of the pool. */
  readOnly?: boolean;
}

/**
 * The default publish/read pool.
 *
 * Order: SIP-01 index relays first (they validate + index at ingestion, so
 * observations become searchable immediately), then NIP-50 search relays,
 * then broad-propagation public relays, then the Tor-only relay.
 */
export const DEFAULT_INDEX_RELAYS: string[] = [
  // SIP-01-aware index relays
  'wss://relay-na1.metanomalist.com/',
  'wss://test-sip-relay.sip-01test.workers.dev/',
  'wss://sip-relay-2.sip-booster-relay.workers.dev/',
  'wss://sip-relay-3.uncaged-sip.workers.dev/',
  'wss://sip-relay-4.sip-relay-4.workers.dev/',
  // NIP-50 search relays (writes accepted)
  'wss://relay.nostr.band/',
  'wss://relay.ditto.pub/',
  'wss://relay.noswhere.com/',
  // Broad propagation
  'wss://jskitty.cat/nostr',
  'wss://relay.primal.net/',
  'wss://relay.damus.io/',
  'wss://nostr.hifish.org/',
  // Tor-only relay. Reachable from Tor Browser, where .onion is a secure
  // context so plain ws:// is fine (the Tor circuit provides the encryption).
  // On clearnet browsers the hostname never resolves; the health gate in
  // publisher.ts auto-skips it after repeated failures.
  'ws://acuy3mjnv26tkyaaucndlxmg2ocntz4rtebhavk57vgruozm42iaznqd.onion/',
];

/** Static capability annotations for pool members we know about. */
export const RELAY_CAPS: Record<string, RelayCaps> = {
  'wss://test-sip-relay.sip-01test.workers.dev/': { sip01: true },
  'wss://sip-relay-2.sip-booster-relay.workers.dev/': { sip01: true },
  'wss://sip-relay-3.uncaged-sip.workers.dev/': { sip01: true },
  'wss://sip-relay-4.sip-relay-4.workers.dev/': { sip01: true },
  'wss://relay.nostr.band/': { nip50: true },
  'wss://relay.ditto.pub/': { nip50: true },
  'wss://relay.noswhere.com/': { nip50: true },
  'wss://search.nos.today/': { nip50: true, readOnly: true },
};

/* ------------------------------------------------------------------------ */
/* User overrides (localStorage)                                             */
/* ------------------------------------------------------------------------ */

const LS_RELAYS = 'indexstr:relay-overrides:v1';

interface RelayOverrides {
  added: string[];
  removed: string[];
}

function readOverrides(): RelayOverrides {
  try {
    const raw = localStorage.getItem(LS_RELAYS);
    if (!raw) return { added: [], removed: [] };
    const parsed = JSON.parse(raw) as Partial<RelayOverrides>;
    return {
      added: Array.isArray(parsed.added) ? parsed.added.filter((u) => typeof u === 'string') : [],
      removed: Array.isArray(parsed.removed) ? parsed.removed.filter((u) => typeof u === 'string') : [],
    };
  } catch {
    return { added: [], removed: [] };
  }
}

function writeOverrides(overrides: RelayOverrides): void {
  try {
    localStorage.setItem(LS_RELAYS, JSON.stringify(overrides));
  } catch {
    // Storage unavailable — overrides become session-only.
  }
}

/**
 * Normalize a relay URL for pool membership: wss:// (ws:// only for .onion,
 * where the Tor circuit provides the encryption), host lowercased, single
 * trailing slash. Returns null for anything else.
 */
export function normalizeRelayUrl(input: string): string | null {
  let candidate = input.trim();
  if (!candidate) return null;
  if (!/^wss?:\/\//i.test(candidate)) candidate = `wss://${candidate}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  const isOnion = url.hostname.toLowerCase().endsWith('.onion');
  if (url.protocol === 'ws:' && !isOnion) return null;
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;

  return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}${url.pathname === '/' ? '/' : url.pathname}${url.search}`;
}

/** The effective publish pool: defaults − removed + added (deduped). */
export function getIndexPublishRelays(): string[] {
  const { added, removed } = readOverrides();
  const removedSet = new Set(removed);
  const pool: string[] = [];
  const seen = new Set<string>();
  for (const url of [...DEFAULT_INDEX_RELAYS, ...added]) {
    if (removedSet.has(url) || seen.has(url)) continue;
    seen.add(url);
    pool.push(url);
  }
  return pool;
}

/** The effective read pool: publish set + NIP-50 search relays (deduped). */
export function getIndexReadRelays(): string[] {
  const pool: string[] = [];
  const seen = new Set<string>();
  for (const url of [...getIndexPublishRelays(), ...SEARCH_RELAYS]) {
    if (seen.has(url)) continue;
    seen.add(url);
    pool.push(url);
  }
  return pool;
}

export function isDefaultRelay(url: string): boolean {
  return DEFAULT_INDEX_RELAYS.includes(url);
}

/** Add a relay to the pool. Returns the normalized URL or null if invalid. */
export function addRelay(input: string): string | null {
  const url = normalizeRelayUrl(input);
  if (!url) return null;
  const overrides = readOverrides();
  if (overrides.removed.includes(url)) {
    // Re-adding a hidden default simply un-hides it.
    overrides.removed = overrides.removed.filter((u) => u !== url);
  } else if (!DEFAULT_INDEX_RELAYS.includes(url) && !overrides.added.includes(url)) {
    overrides.added.push(url);
  }
  writeOverrides(overrides);
  return url;
}

/**
 * Remove a relay from the pool. Defaults are soft-removed (hidden, can be
 * restored with Reset); customs are dropped from the added list.
 */
export function removeRelay(url: string): void {
  const overrides = readOverrides();
  if (DEFAULT_INDEX_RELAYS.includes(url)) {
    if (!overrides.removed.includes(url)) overrides.removed.push(url);
  } else {
    overrides.added = overrides.added.filter((u) => u !== url);
  }
  writeOverrides(overrides);
}

/** Restore the built-in pool. */
export function resetRelays(): void {
  writeOverrides({ added: [], removed: [] });
}
