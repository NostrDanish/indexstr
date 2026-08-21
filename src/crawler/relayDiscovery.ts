/**
 * Relay auto-discovery — find SIP-01 / NIP-50 capable relays without a
 * central registry.
 *
 * Two-stage, both permissionless:
 *
 *   1. NIP-66 (kind 30166): public relay monitors continuously announce
 *      relay characteristics. We query for relays advertising NIP-50
 *      (`#N: ["50"]`) or accepting kind 39697 (`#k: ["39697"]`).
 *   2. NIP-11 probe: each candidate's relay information document is
 *      fetched (Accept: application/nostr+json) and checked for
 *      `supported_nips: […, 50, …]` and the SIP-01 `uncaged_index` block
 *      (spec §15) — advertisement verified, not just claimed by a monitor.
 *
 * Nothing found this way is trusted blindly: discovered relays are offered
 * to the user as candidates to add, never silently joined.
 */

import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { getIndexPublishRelays, normalizeRelayUrl, SEARCH_RELAYS } from './relays';

/** NIP-66 relay discovery events. */
const RELAY_DISCOVERY_KIND = 30166;

/** Public monitor-heavy relays worth asking for 30166 data. */
const DISCOVERY_RELAYS = [
  'wss://relay.nostr.watch/',
  'wss://relay.nostr.band/',
];

export interface DiscoveredRelay {
  /** Normalized relay URL. */
  url: string;
  /** Monitor claims NIP-50 support (NIP-66 `N` tag). */
  nip50: boolean;
  /** Monitor claims kind 39697 acceptance (NIP-66 `k` tag). */
  acceptsSip01Kind: boolean;
  /** NIP-11 probe: supported_nips includes 50. null = not probed/failed. */
  probedNip50: boolean | null;
  /** NIP-11 probe: uncaged_index.sip01 block present. null = not probed. */
  probedSip01: boolean | null;
  /** Already in the effective pool. */
  inPool: boolean;
}

export type RelayQueryFn = (filters: NostrFilter[], relays: string[]) => Promise<NostrEvent[]>;

/** Stage 1: collect candidate relays from NIP-66 monitor events. */
export async function discoverRelayCandidates(
  queryFn: RelayQueryFn,
): Promise<DiscoveredRelay[]> {
  const inPool = new Set([...getIndexPublishRelays(), ...SEARCH_RELAYS]);
  const byUrl = new Map<string, DiscoveredRelay>();

  const ingest = (events: NostrEvent[]) => {
    for (const event of events) {
      if (event.kind !== RELAY_DISCOVERY_KIND) continue;
      const d = event.tags.find(([n]) => n === 'd')?.[1];
      if (!d) continue;
      const url = normalizeRelayUrl(d);
      if (!url) continue;

      const nips = event.tags.filter(([n]) => n === 'N').map(([, v]) => v);
      const kinds = event.tags.filter(([n]) => n === 'k').map(([, v]) => v);
      const nip50 = nips.includes('50');
      const acceptsSip01Kind = kinds.includes('39697') || kinds.includes('39697!');
      if (!nip50 && !acceptsSip01Kind) continue;

      const existing = byUrl.get(url);
      if (existing) {
        existing.nip50 = existing.nip50 || nip50;
        existing.acceptsSip01Kind = existing.acceptsSip01Kind || acceptsSip01Kind;
      } else {
        byUrl.set(url, {
          url,
          nip50,
          acceptsSip01Kind,
          probedNip50: null,
          probedSip01: null,
          inPool: inPool.has(url),
        });
      }
    }
  };

  // Tag-filtered first (cheap on relays that index these tags)…
  const filtered = await queryFn(
    [
      { kinds: [RELAY_DISCOVERY_KIND], '#N': ['50'], limit: 200 },
      { kinds: [RELAY_DISCOVERY_KIND], '#k': ['39697'], limit: 100 },
    ],
    DISCOVERY_RELAYS,
  );
  ingest(filtered);

  // …then an unfiltered sample with client-side filtering as fallback.
  if (byUrl.size === 0) {
    const broad = await queryFn(
      [{ kinds: [RELAY_DISCOVERY_KIND], limit: 400 }],
      DISCOVERY_RELAYS,
    );
    ingest(broad);
  }

  return [...byUrl.values()].sort((a, b) => {
    // Most-interesting first: SIP-01 claim > NIP-50 claim.
    const score = (r: DiscoveredRelay) => (r.acceptsSip01Kind ? 2 : 0) + (r.nip50 ? 1 : 0);
    return score(b) - score(a);
  });
}

/**
 * Stage 2: probe a relay's NIP-11 document. Verifies claimed capabilities
 * against the relay's own advertisement, including the SIP-01
 * `uncaged_index` block (spec §15).
 */
export async function probeRelay(
  url: string,
): Promise<{ nip50: boolean; sip01: boolean } | null> {
  let httpUrl: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'wss:') return null; // NIP-11 needs https (no .onion probe here)
    httpUrl = `https://${u.host}/`;
  } catch {
    return null;
  }

  try {
    const response = await fetch(httpUrl, {
      headers: { Accept: 'application/nostr+json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return null;
    const doc = (await response.json()) as Record<string, unknown>;

    const supported = Array.isArray(doc.supported_nips) ? doc.supported_nips : [];
    const nip50 = supported.includes(50);

    const uncaged = doc.uncaged_index as Record<string, unknown> | undefined;
    const sip01 = uncaged?.sip01 === true;

    return { nip50, sip01 };
  } catch {
    return null;
  }
}

/** Probe a list of candidates in parallel, mutating their probed fields. */
export async function probeCandidates(candidates: DiscoveredRelay[], max = 12): Promise<void> {
  await Promise.allSettled(
    candidates.slice(0, max).map(async (candidate) => {
      const result = await probeRelay(candidate.url);
      if (result) {
        candidate.probedNip50 = result.nip50;
        candidate.probedSip01 = result.sip01;
      }
    }),
  );
}
