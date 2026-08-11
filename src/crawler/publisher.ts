/**
 * Index publisher — signs and publishes SIP-01 web index observations
 * (kind 39697). Canonical spec: https://github.com/NostrDanish/SIP-01
 * (public/spec/SIP-01.md, v1.1).
 *
 * Every observation is signed by THIS DEVICE's dedicated indexer identity
 * (indexerIdentity.ts) — never the user's personal Nostr key, and
 * the event never contains a search query. The user's identity and the
 * indexer identity are never linked on purpose.
 *
 * Relay resilience:
 *   - each event is pushed to every relay in the publish set, best-effort
 *   - per-relay health is tracked (see getRelayHealth) for the settings UI
 *   - when ZERO relays accept an event, it is held in the IndexedDB outbox
 *     and flushed when connectivity returns — local-first, nothing lost
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from '@nostrify/nostrify';

import { getIndexerIdentity, getIndexerSecretKey } from './indexerIdentity';
import { buildIndexEvent, normalizeIndexUrl, type IndexObservationInput } from './webIndex';
import { getIndexPublishRelays } from './relays';
import { enqueueOutbox, flushOutbox } from './queue';

/** Callback type for publishing a signed event to a relay. */
export type RelayPublishFn = (relayUrl: string, event: NostrEvent) => Promise<void>;

/** Injected relay publisher — wired up by the React hook. */
let relayPublishFn: RelayPublishFn | null = null;

export function setRelayPublisher(fn: RelayPublishFn) {
  relayPublishFn = fn;
}

/* ------------------------------------------------------------------------ */
/* Relay health                                                              */
/* ------------------------------------------------------------------------ */

export interface RelayHealth {
  ok: number;
  fail: number;
  /** unix ms of last accepted event; 0 = never */
  lastOk: number;
  /** last error message, if the last attempt failed */
  lastError?: string;
}

const relayHealth = new Map<string, RelayHealth>();

function recordRelay(relayUrl: string, success: boolean, error?: unknown): void {
  const entry = relayHealth.get(relayUrl) ?? { ok: 0, fail: 0, lastOk: 0 };
  if (success) {
    entry.ok++;
    entry.lastOk = Date.now();
    entry.lastError = undefined;
  } else {
    entry.fail++;
    entry.lastError = error instanceof Error ? error.message : String(error);
  }
  relayHealth.set(relayUrl, entry);
}

/** Snapshot of per-relay health for the UI. */
export function getRelayHealth(): Record<string, RelayHealth> {
  return Object.fromEntries(relayHealth);
}

/* ------------------------------------------------------------------------ */
/* Publishing                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Publish a signed event to all index relays (best-effort).
 * Returns the number of relays that accepted it.
 */
async function publishToIndexRelays(signedEvent: NostrEvent): Promise<number> {
  const relays = getIndexPublishRelays();

  if (!relayPublishFn) {
    console.debug('[Crawler] No relay publisher configured. Would publish to:', relays);
    return 0;
  }

  const results = await Promise.allSettled(
    relays.map(async (url) => {
      await relayPublishFn!(url, signedEvent);
      recordRelay(url, true);
    }),
  );

  let accepted = 0;
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      accepted++;
    } else {
      recordRelay(relays[i], false, result.reason);
      console.debug(`[Crawler] Publish failed for ${relays[i]}:`, result.reason);
    }
  });
  return accepted;
}

/**
 * Publish a pre-signed event again (outbox flush). True when at least one
 * relay accepted it.
 */
export async function republishEvent(event: NostrEvent): Promise<boolean> {
  return (await publishToIndexRelays(event)) > 0;
}

/** Drain the outbox through the relay pool. Returns events delivered. */
export async function flushObservationOutbox(): Promise<number> {
  return flushOutbox(republishEvent);
}

export interface PublishResult {
  normalizedUrl: string;
  /** Relays that accepted the event (0 → held in the outbox). */
  delivered: number;
}

/**
 * Build, sign, and publish one web index observation.
 *
 * Returns null when the input is not indexable (non-http(s) URL, empty
 * title). Relay failures are swallowed into the outbox — indexing is
 * best-effort and must never break the crawl loop.
 */
export async function publishIndexObservation(
  input: IndexObservationInput,
): Promise<PublishResult | null> {
  const normalized = normalizeIndexUrl(input.url);
  if (!normalized) return null;

  const template = await buildIndexEvent({ ...input, url: normalized });
  if (!template) return null;

  const signedEvent = finalizeEvent(
    {
      kind: template.kind,
      created_at: Math.floor(Date.now() / 1000),
      tags: template.tags,
      content: template.content,
      pubkey: getIndexerIdentity().pubkeyHex,
    },
    getIndexerSecretKey(),
  );

  const delivered = await publishToIndexRelays(signedEvent);
  if (delivered === 0) {
    await enqueueOutbox(signedEvent);
  }
  return { normalizedUrl: normalized, delivered };
}

/**
 * Get the current indexer identity info for display purposes.
 */
export function getIndexerInfo(): { pubkeyHex: string; npub: string } {
  const identity = getIndexerIdentity();
  return {
    pubkeyHex: identity.pubkeyHex,
    npub: identity.npub,
  };
}
