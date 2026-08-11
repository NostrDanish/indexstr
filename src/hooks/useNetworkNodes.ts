/**
 * Network view — how many Indexstr nodes are heartbeat-visible right now?
 *
 * This queries the app's relay pool for recent kind 16919 heartbeats and
 * counts distinct indexer pubkeys. It is a LOCAL ESTIMATE: your relay view
 * is never the whole network. The UI must label it accordingly.
 */

import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import {
  INDEXSTR_HEARTBEAT_KIND,
  HEARTBEAT_TTL_S,
  parseHeartbeat,
  type ParsedHeartbeat,
} from '@/crawler/heartbeat';

export interface NetworkNodesResult {
  /** Distinct indexers with a heartbeat inside the TTL. */
  activeIndexers: number;
  /** Distinct home shards claimed by those indexers. */
  activeShards: number;
  /** When the estimate was computed (unix ms). */
  sampledAt: number;
}

export function useNetworkNodes(enabled = true) {
  const { nostr } = useNostr();

  return useQuery<NetworkNodesResult>({
    queryKey: ['indexstr-network-nodes'],
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const since = Math.floor(Date.now() / 1000) - HEARTBEAT_TTL_S;
      const events = await nostr.query(
        [{ kinds: [INDEXSTR_HEARTBEAT_KIND], since, limit: 500 }],
        { signal },
      );

      const pubkeys = new Set<string>();
      const shards = new Set<string>();
      for (const event of events) {
        const parsed: ParsedHeartbeat | null = parseHeartbeat(event);
        if (!parsed) continue;
        pubkeys.add(parsed.pubkey);
        shards.add(parsed.shard);
      }

      return {
        activeIndexers: pubkeys.size,
        activeShards: shards.size,
        sampledAt: Date.now(),
      };
    },
  });
}
