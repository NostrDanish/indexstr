/**
 * Indexstr node heartbeat — kind 16919 (replaceable).
 *
 * Every node that starts crawling publishes a small signed heartbeat so the
 * network can answer "who is indexing right now?" without any coordinator:
 * consumers query recent kind-16919 events from their relays and count
 * distinct pubkeys. One replaceable event per node; the latest write wins.
 *
 * A heartbeat is *self-reported and unverified* — it says "I am here and
 * this is what my counters say", useful for coverage/health estimates. It
 * is NOT a reputation input: reputation must be derived from signed kind
 * 39697 observations (independent, comparable), never from self-reports.
 *
 * Privacy: only coarse capability classes (see capabilities.ts). No
 * location, no IP, no device model, no fine-grained fingerprint.
 */

import { finalizeEvent, type EventTemplate } from 'nostr-tools/pure';
import type { NostrEvent } from '@nostrify/nostrify';
import { getIndexerIdentity, getIndexerSecretKey } from './indexerIdentity';
import { nodeShard, shardLabel } from './sharding';
import { getNodeCapabilities, INDEXSTR_NODE_VERSION } from './capabilities';

/** Replaceable event kind for Indexstr node heartbeats. */
export const INDEXSTR_HEARTBEAT_KIND = 16919;

/** Heartbeats older than this are considered offline. */
export const HEARTBEAT_TTL_S = 3600;

/** How often a running node re-publishes its heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

export interface HeartbeatStats {
  pagesIndexed: number;
  queueSize: number;
  published: number;
}

export interface HeartbeatPayload {
  v: string;
  shard: string;
  platform: string;
  network: string;
  charging: boolean;
  stats: HeartbeatStats;
}

export interface ParsedHeartbeat extends HeartbeatPayload {
  pubkey: string;
  createdAt: number;
}

/** Build and sign this node's heartbeat. */
export async function buildHeartbeat(stats: HeartbeatStats): Promise<NostrEvent> {
  const identity = getIndexerIdentity();
  const caps = await getNodeCapabilities();
  const shard = nodeShard(identity.pubkeyHex);

  const payload: HeartbeatPayload = {
    v: INDEXSTR_NODE_VERSION,
    shard: shardLabel(shard),
    platform: caps.platform,
    network: caps.network,
    charging: caps.charging,
    stats,
  };

  const template: EventTemplate = {
    kind: INDEXSTR_HEARTBEAT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: JSON.stringify(payload),
    tags: [
      ['v', INDEXSTR_NODE_VERSION],
      ['shard', shardLabel(shard)],
      ['source', 'indexstr/1'],
      ['alt', `Indexstr node heartbeat: shard ${shardLabel(shard)}`],
    ],
  };

  return finalizeEvent(template, getIndexerSecretKey());
}

/** Structural validation for incoming heartbeats. */
export function parseHeartbeat(event: NostrEvent): ParsedHeartbeat | null {
  if (event.kind !== INDEXSTR_HEARTBEAT_KIND) return null;
  try {
    const payload = JSON.parse(event.content) as Partial<HeartbeatPayload>;
    const shard = payload.shard;
    if (typeof shard !== 'string' || !/^[0-9A-F]{2}$/.test(shard)) return null;
    if (typeof payload.v !== 'string') return null;
    return {
      pubkey: event.pubkey,
      createdAt: event.created_at,
      v: payload.v,
      shard,
      platform: typeof payload.platform === 'string' ? payload.platform.slice(0, 16) : 'unknown',
      network: typeof payload.network === 'string' ? payload.network.slice(0, 24) : 'unknown',
      charging: payload.charging === true,
      stats: {
        pagesIndexed: Math.max(0, Number(payload.stats?.pagesIndexed) || 0),
        queueSize: Math.max(0, Number(payload.stats?.queueSize) || 0),
        published: Math.max(0, Number(payload.stats?.published) || 0),
      },
    };
  } catch {
    return null;
  }
}
