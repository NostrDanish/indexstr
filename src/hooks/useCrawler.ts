// React hook for the crawler engine
// Wires up SIP-01 publishing via Nostr relays

import { useEffect, useRef, useState, useCallback } from 'react';
import { useNostr } from '@nostrify/react';
import { CrawlerEngine } from '@/crawler/engine';
import { setRelayPublisher, getIndexerInfo } from '@/crawler/publisher';
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
  });
  const [recentCrawls, setRecentCrawls] = useState<Array<{
    url: string;
    title: string;
    crawledAt: number;
  }>>([]);
  const [indexerInfo, setIndexerInfo] = useState<{ pubkeyHex: string; npub: string } | null>(null);

  // Initialize engine and indexer identity
  useEffect(() => {
    const engine = new CrawlerEngine();
    engine.init().then(() => {
      engineRef.current = engine;
      setInitialized(true);
      setStats(engine.getStats());
      setIndexerInfo(getIndexerInfo());
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
  // list is authoritative, not merely decorative.
  useEffect(() => {
    setRelayPublisher(async (relayUrl, event) => {
      try {
        await nostr.relay(relayUrl).event(event, { signal: AbortSignal.timeout(10000) });
      } catch (error) {
        console.debug(`[Crawler] Publish failed for ${relayUrl}:`, error);
      }
    });
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
      maxBandwidthMB: 25,
      maxPagesPerHour: 100,
      maxDepth: 3,
      maxConcurrent: 1,
      maxPageSizeKB: 2048,
      ecoMode: true,
    };
  }, []);

  return {
    isRunning,
    initialized,
    stats,
    recentCrawls,
    indexerInfo,
    start,
    stop,
    seedUrl,
    seedCollection,
    clearAll,
    updateSettings,
    getSettings,
  };
}
