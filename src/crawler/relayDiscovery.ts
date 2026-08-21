/**
 * Relay auto-discovery — finds NIP-50-capable (and SIP-01-aware) relays
 * without any hard-coded directory.
 *
 * Strategy (NIP-66):
 *   1. Query kind 30166 relay-discovery events from monitor relays.
 *   2. Keep relays that advertise NIP-50 (`N` tag = "50") or kind 39697
 *      acceptance (`k` tag).
 *   3. Verify each candidate with a real NIP-11 probe (relayProbe.ts) —
 *      a 30166 is a monitor's claim, not proof; the probe is the truth.
 *   4. Report which verified relays are also SIP-01-aware (the
 *      `uncaged_index` block from the relay's NIP-11 document).
 *
 * Per NIP-66's risk guidance: discovery is a hint, never a requirement —
 * the built-in relay set keeps the app fully functional without it.
 */

import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { probeRelays, type RelayCapabilities } from './relayProbe';
import { normalizeRelayUrl } from './relays';

/** Relay-discovery events (NIP-66). */
const RELAY_DISCOVERY_KIND = 30166;

/** Well-known monitor relays that aggregate kind 30166 events. */
const MONITOR_RELAYS = [
  'wss://relay.nostr.watch/',
  'wss://relay.damus.io/',
  'wss://relay.nostr.band/',
];

/** Query function shape (subset of the nostr object we need). */
export type QueryFn = (
  relays: string[],
  filters: NostrFilter[],
) => Promise<NostrEvent[]>;

/**
 * Extract relay URLs that advertise a given NIP or kind from kind 30166
 * events. The `N` tag lists supported NIPs by number; `k` lists accepted
 * event kinds.
 */
export function extractRelayCandidates(
  events: NostrEvent[],
  { nip, kind }: { nip?: number; kind?: number },
): string[] {
  const nipStr = nip !== undefined ? String(nip) : undefined;
  const kindStr = kind !== undefined ? String(kind) : undefined;
  const urls = new Set<string>();

  for (const event of events) {
    if (event.kind !== RELAY_DISCOVERY_KIND) continue;
    const hasNip = nipStr !== undefined && event.tags.some(([n, v]) => n === 'N' && v === nipStr);
    const hasKind = kindStr !== undefined && event.tags.some(([n, v]) => n === 'k' && v === kindStr);
    if (!hasNip && !hasKind) continue;

    const d = event.tags.find(([n]) => n === 'd')?.[1];
    if (!d) continue;

    const normalized = normalizeRelayUrl(d);
    if (normalized && normalized.startsWith('wss://')) {
      urls.add(normalized);
    }
  }

  return [...urls];
}

/**
 * Discover relays: query NIP-66 announcements, filter to NIP-50/SIP-01
 * candidates, verify each with a live NIP-11 probe, and return the
 * verified set.
 *
 * `queryFn` is supplied by the caller (it needs the app's nostr pool) —
 * this module stays transport-agnostic.
 */
export async function discoverRelays(
  queryFn: QueryFn,
  options: { limit?: number; verifyTop?: number } = {},
): Promise<{ candidates: string[]; verified: RelayCapabilities[] }> {
  const limit = options.limit ?? 400;
  const verifyTop = options.verifyTop ?? 20;

  let events: NostrEvent[] = [];
  try {
    events = await queryFn(MONITOR_RELAYS, [
      { kinds: [RELAY_DISCOVERY_KIND], limit },
    ]);
  } catch {
    return { candidates: [], verified: [] };
  }

  // Candidates: NIP-50 advertised, or kind 39697 accepted, in monitor data.
  const candidates = [
    ...new Set([
      ...extractRelayCandidates(events, { nip: 50 }),
      ...extractRelayCandidates(events, { kind: 39697 }),
    ]),
  ];

  // Verify a slice with real probes (parallel, each with its own timeout).
  const verified = await probeRelays(candidates.slice(0, verifyTop));

  return { candidates, verified: verified.filter((r) => r.online) };
}
