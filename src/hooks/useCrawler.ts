// React hook for the crawler engine
// Wires up SIP-01 publishing + node heartbeats via Nostr relays

import { useEffect, useRef, useState, useCallback } from 'react';
import { useNostr } from '@nostrify/react';
import type { NostrEvent } from '@nostrify/nostrify';
import { CrawlerEngine, setEngineRelayPublisher } from '@/crawler/engine';
import { setRelayPublisher, getIndexerInfo, type RelayHealth } from '@/crawler/publisher';
import { shardLabel } from '@/crawler/sharding';
import type { NodeCapabilities } from '@/crawler/capabilities';
import type { CrawlerStats, CrawlerSettings } from '@/crawler/types';

export function useCrawler() {
  const { nostr } = useNostr();
  const engineRef = useRef<CrawlerEngine | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [stats, setStats] = useState<CrawlerStats>({
    pagesIndexed: 0,
    queueSize: 0,
    bandwidthUsed: 0,
    uptime: 0,
    errors: 0,
    skipped: 0,
    viaProxy: 0,
    viaDirect: 0,
    robotsBlocked: 0,
    fetchFailed: 0,
    duplicates: 0,
    thinContent: 0,
    published: 0,
    outboxPending: 0,
    discovered: 0,
    homeShardJobs: 0,
  });
  const [recentCrawls, setRecentCrawls] = useState<Array<{
    url: string;
    title: string;
    crawledAt: number;
  }>>([]);
  const [indexerInfo, setIndexerInfo] = useState<{ pubkeyHex: string; npub: string } | null>(null);
  const [homeShard, setHomeShard] = useState<number | null>(null);
  const [capabilities, setCapabilities] = useState<NodeCapabilities | null>(null);

  // Initialize engine and indexer identity
  useEffect(() => {
    const engine = new CrawlerEngine();
    engine.init().then(() => {
      engineRef.current = engine;
      setInitialized(true);
      setStats(engine.getStats());
      setIndexerInfo(getIndexerInfo());
      setHomeShard(engine.homeShard);
      void engine.getCapabilities().then(setCapabilities);
    });

    engine.onStats((newStats) => {
      setStats(newStats);
    });

    return () => {
      engine.stop();
    };
  }, []);

  // Wire up relay publishing. Each crawl observation is pushed to every relay
  // in the index publish set via a targeted per-relay connection — the crawler
  // list is authoritative, not merely decorative. The same transport carries
  // the node's heartbeat events.
  useEffect(() => {
    const publish = async (relayUrl: string, event: NostrEvent) => {
      try {
        await nostr.relay(relayUrl).event(event, { signal: AbortSignal.timeout(10000) });
      } catch (error) {
        console.debug(`[Crawler] Publish failed for ${relayUrl}:`, error);
        throw error; // publisher tracks per-relay health on failure
      }
    };
    setRelayPublisher(publish);
    setEngineRelayPublisher(publish);
  }, [nostr]);

  // Poll recent crawls
  useEffect(() => {
    if (!initialized) return;

    const loadRecent = async () => {
      if (engineRef.current) {
        const recent = await engineRef.current.getRecentCrawls(20);
        setRecentCrawls(recent);
      }
    };

    loadRecent();
    const interval = setInterval(loadRecent, 10000);
    return () => clearInterval(interval);
  }, [initialized, isRunning]);

  const start = useCallback(async () => {
    if (!engineRef.current) return;
    await engineRef.current.start();
    setIsRunning(true);
  }, []);

  const stop = useCallback(async () => {
    if (!engineRef.current) return;
    await engineRef.current.stop();
    setIsRunning(false);
  }, []);

  const seedUrl = useCallback(async (url: string) => {
    if (!engineRef.current) return;
    await engineRef.current.seedUrl(url);
  }, []);

  const seedCollection = useCallback(
    async (urls: string[], onProgress?: (done: number, total: number) => void): Promise<number> => {
      if (!engineRef.current) return 0;
      return engineRef.current.seedCollection(urls, onProgress);
    },
    [],
  );

  const clearAll = useCallback(async () => {
    if (!engineRef.current) return;
    await engineRef.current.clearAll();
  }, []);

  const updateSettings = useCallback((settings: Partial<CrawlerSettings>) => {
    if (!engineRef.current) return;
    engineRef.current.updateSettings(settings);
  }, []);

  const getSettings = useCallback((): CrawlerSettings => {
    return engineRef.current?.getSettings() ?? {
      wifiOnly: false,
      chargingOnly: false,
      respectRobots: true,
      maxBandwidthMB: 250,
      maxPagesPerHour: 100,
      maxDepth: 3,
      maxConcurrent: 1,
      maxPageSizeKB: 2048,
      ecoMode: true,
    };
  }, []);

  const getRelayHealth = useCallback((): Record<string, RelayHealth> => {
    return engineRef.current?.getRelayHealth() ?? {};
  }, []);

  return {
    isRunning,
    initialized,
    stats,
    recentCrawls,
    indexerInfo,
    /** This node's deterministic home shard (0–255). */
    homeShard,
    /** e.g. "A7" */
    homeShardLabel: homeShard === null ? null : shardLabel(homeShard),
    capabilities,
    start,
    stop,
    seedUrl,
    seedCollection,
    clearAll,
    updateSettings,
    getSettings,
    getRelayHealth,
  };
}
