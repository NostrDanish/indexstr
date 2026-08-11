// Main crawler engine — orchestrates the crawl loop
// Publishes SIP-01 (kind 39697) web index observations via the shared protocol
//
// Indexstr is a *network node*: every job carries a deterministic shard
// (sharding.ts), the scheduler prefers the node's home shard, heartbeats
// (kind 16919) announce presence, and observations that can't reach any
// relay wait in the IndexedDB outbox instead of being lost.

import { fetchPage } from './fetcher';
import { parsePage } from './parser';
import { normalizeIndexUrl } from './webIndex';
import { hashContent } from './hasher';
import { shouldCrawlUrl, getCrawlDelay } from './robots';
import { canMakeRequest } from './limits';
import {
  publishIndexObservation,
  flushObservationOutbox,
  getRelayHealth,
  type RelayHealth,
} from './publisher';
import { buildHeartbeat, HEARTBEAT_INTERVAL_MS } from './heartbeat';
import { getIndexerIdentity } from './indexerIdentity';
import { urlShard, nodeShard, CROSS_SHARD_SAMPLING } from './sharding';
import { getNodeCapabilities, type NodeCapabilities } from './capabilities';
import { getIndexPublishRelays } from './relays';
import {
  initDB,
  addToQueue,
  addManyToQueue,
  getNextJob,
  removeFromQueue,
  getQueueSize,
  getQueueShardCount,
  getCrawled,
  markCrawled,
  findByHash,
  getCrawledCount,
  getCrawledUrlSet,
  getRecentCrawled,
  clearQueue,
  getOutboxSize,
} from './queue';
import { DEFAULT_SETTINGS, type CrawlerStats, type CrawlerSettings, type CrawlJob } from './types';

/**
 * Map well-known hosts to SIP-01 §9.2 `platform` extension values.
 * Deliberately small — an unrecognised host simply gets no platform tag.
 */
function detectPlatform(host: string): string | undefined {
  const h = host.toLowerCase();
  if (h === 'github.com' || h.endsWith('.github.com') || h.endsWith('.github.io')) return 'github';
  if (h === 'gitlab.com' || h.endsWith('.gitlab.com')) return 'gitlab';
  if (h === 'youtube.com' || h === 'youtu.be' || h.endsWith('.youtube.com')) return 'youtube';
  if (h === 'wikipedia.org' || h.endsWith('.wikipedia.org')) return 'wikipedia';
  if (h === 'medium.com' || h.endsWith('.medium.com')) return 'medium';
  if (h === 'dev.to') return 'devto';
  if (h === 'news.ycombinator.com') return 'hackernews';
  if (h.endsWith('.reddit.com') || h === 'reddit.com') return 'reddit';
  if (h === 'stackoverflow.com' || h.endsWith('.stackexchange.com')) return 'stackoverflow';
  return undefined;
}

/** Publishes a signed event to one relay; injected by the React layer. */
export type EngineRelayPublish = (relayUrl: string, event: import('@nostrify/nostrify').NostrEvent) => Promise<void>;

let engineRelayPublish: EngineRelayPublish | null = null;

/** Wire the engine's heartbeat transport (same connection pool as observations). */
export function setEngineRelayPublisher(fn: EngineRelayPublish): void {
  engineRelayPublish = fn;
}

export class CrawlerEngine {
  private running = false;
  private startTime = 0;
  private settings: CrawlerSettings;
  private stats: CrawlerStats = {
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
  };
  private abortController: AbortController | null = null;
  private onStatsChange?: (stats: CrawlerStats) => void;
  /** This node's home shard (0–255), derived from the indexer pubkey. */
  readonly homeShard: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  private onlineHandler: (() => void) | null = null;

  constructor(settings?: Partial<CrawlerSettings>) {
    const stored = localStorage.getItem('indexstr-settings');
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(stored ? JSON.parse(stored) : {}),
      ...settings,
    };
    this.homeShard = nodeShard(getIndexerIdentity().pubkeyHex);
  }

  async init(): Promise<void> {
    await initDB();
    this.stats.queueSize = await getQueueSize();
    this.stats.pagesIndexed = await getCrawledCount();
    this.stats.outboxPending = await getOutboxSize();
    this.stats.homeShardJobs = await getQueueShardCount(this.homeShard);
  }

  onStats(callback: (stats: CrawlerStats) => void): void {
    this.onStatsChange = callback;
  }

  private emitStats(): void {
    this.stats.uptime = this.running ? Math.floor((Date.now() - this.startTime) / 1000) : 0;
    this.onStatsChange?.({ ...this.stats });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startTime = Date.now();
    this.abortController = new AbortController();
    this.emitStats();

    // Announce this node to the network, then keep the heartbeat fresh.
    void this.publishHeartbeat();
    this.heartbeatTimer = setInterval(() => void this.publishHeartbeat(), HEARTBEAT_INTERVAL_MS);

    // Flush anything held from an offline period, now and periodically.
    void this.flushOutbox();
    this.outboxTimer = setInterval(() => void this.flushOutbox(), 5 * 60 * 1000);
    this.onlineHandler = () => void this.flushOutbox();
    window.addEventListener('online', this.onlineHandler);

    this.crawlLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    this.heartbeatTimer = null;
    this.outboxTimer = null;
    if (this.onlineHandler) {
      window.removeEventListener('online', this.onlineHandler);
      this.onlineHandler = null;
    }
    this.emitStats();
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Coarse, privacy-minimal capability snapshot (battery/network/platform). */
  getCapabilities(): Promise<NodeCapabilities> {
    return getNodeCapabilities();
  }

  /** Per-relay publish health for the settings UI. */
  getRelayHealth(): Record<string, RelayHealth> {
    return getRelayHealth();
  }

  /** Sign and publish a kind 16919 heartbeat to the index relay pool. */
  private async publishHeartbeat(): Promise<void> {
    if (!engineRelayPublish) return;
    try {
      const event = await buildHeartbeat({
        pagesIndexed: this.stats.pagesIndexed,
        queueSize: this.stats.queueSize,
        published: this.stats.published,
      });
      await Promise.allSettled(
        getIndexPublishRelays().map((url) => engineRelayPublish!(url, event)),
      );
    } catch (error) {
      console.debug('[Crawler] Heartbeat publish failed:', error);
    }
  }

  /** Deliver held observations; update stats. */
  private async flushOutbox(): Promise<void> {
    try {
      const delivered = await flushObservationOutbox();
      if (delivered > 0) this.stats.published += delivered;
      this.stats.outboxPending = await getOutboxSize();
      this.emitStats();
    } catch (error) {
      console.debug('[Crawler] Outbox flush failed:', error);
    }
  }

  getStats(): CrawlerStats {
    return { ...this.stats };
  }

  getSettings(): CrawlerSettings {
    return { ...this.settings };
  }

  updateSettings(settings: Partial<CrawlerSettings>): void {
    this.settings = { ...this.settings, ...settings };
    localStorage.setItem('indexstr-settings', JSON.stringify(this.settings));
  }

  async seedUrl(url: string, priority = 1.0): Promise<void> {
    const normalizedUrl = normalizeIndexUrl(url);
    if (!normalizedUrl) return;
    await addToQueue({
      url: normalizedUrl,
      priority,
      depth: 0,
      attempts: 0,
      followLinks: true, // manual seeds self-expand; collections don't
      shard: urlShard(normalizedUrl),
    });
    this.stats.queueSize = await getQueueSize();
    this.stats.homeShardJobs = await getQueueShardCount(this.homeShard);
    this.emitStats();
  }

  /**
   * Seed a curated collection: a large list of pre-normalized URLs that are
   * indexed exactly as listed — no link following (the collection IS the
   * crawl plan). URLs already crawled are skipped. Returns how many jobs
   * were added.
   */
  async seedCollection(
    urls: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<number> {
    const crawled = await getCrawledUrlSet();
    const jobs: CrawlJob[] = [];
    for (const url of urls) {
      if (crawled.has(url)) continue;
      jobs.push({
        url,
        priority: 0.9,
        depth: 0,
        attempts: 0,
        followLinks: false,
        shard: urlShard(url),
      });
    }
    await addManyToQueue(jobs, onProgress);
    this.stats.queueSize = await getQueueSize();
    this.stats.homeShardJobs = await getQueueShardCount(this.homeShard);
    this.emitStats();
    return jobs.length;
  }

  async clearAll(): Promise<void> {
    await clearQueue();
    this.stats.queueSize = 0;
    this.emitStats();
  }

  async getRecentCrawls(limit = 20) {
    return getRecentCrawled(limit);
  }

  private async crawlLoop(): Promise<void> {
    while (this.running) {
      try {
        if (!(await this.canCrawl())) {
          await this.sleep(10000);
          continue;
        }

        // Shard-preferential scheduling: mostly home-shard work, with
        // cross-shard sampling so sparse networks still cover everything.
        const job = await getNextJob(this.homeShard, CROSS_SHARD_SAMPLING);
        if (!job) {
          await this.sleep(5000);
          continue;
        }

        if (!(await canMakeRequest(job.url))) {
          job.nextAttempt = Date.now() + 10000;
          await addToQueue(job);
          await this.sleep(5000);
          continue;
        }

        await this.crawlUrl(job);
        this.emitStats();

        const crawlDelay = this.settings.respectRobots ? await getCrawlDelay(job.url) : 0;
        await this.sleep(Math.max(crawlDelay, this.settings.ecoMode ? 8000 : 3000));
      } catch (error) {
        console.error('[Crawler] Loop error:', error);
        this.stats.errors++;
        this.emitStats();
        await this.sleep(10000);
      }
    }
  }

  private async crawlUrl(job: CrawlJob): Promise<void> {
    // Check if already crawled
    const existing = await getCrawled(job.url);
    if (existing) {
      await removeFromQueue(job.url);
      this.stats.skipped++;
      return;
    }

    // Check robots.txt
    if (this.settings.respectRobots) {
      const allowed = await shouldCrawlUrl(job.url);
      if (!allowed) {
        console.debug('[Crawler] Blocked by robots.txt:', job.url);
        await removeFromQueue(job.url);
        this.stats.skipped++;
        this.stats.robotsBlocked++;
        return;
      }
    }

    // Fetch page
    const result = await fetchPage(job.url, this.settings.maxPageSizeKB);
    if (!result) {
      this.stats.errors++;
      this.stats.fetchFailed++;
      job.attempts++;
      if (job.attempts >= 3) {
        await removeFromQueue(job.url);
      } else {
        job.nextAttempt = Date.now() + Math.pow(2, job.attempts) * 60000;
        await addToQueue(job);
      }
      return;
    }

    // Parse content
    const parsed = parsePage(result.html, job.url);

    // Skip pages with very little content
    if (parsed.wordCount < 10) {
      await removeFromQueue(job.url);
      this.stats.skipped++;
      this.stats.thinContent++;
      return;
    }

    // Hash content for local dedup
    const localHash = await hashContent(parsed.text);

    // Check for duplicate content locally
    const duplicate = await findByHash(localHash);
    if (duplicate) {
      await removeFromQueue(job.url);
      this.stats.skipped++;
      this.stats.duplicates++;
      return;
    }

    // Mark as crawled locally
    await markCrawled(job.url, localHash, parsed.title);
    await removeFromQueue(job.url);

    // Update stats
    this.stats.pagesIndexed++;
    this.stats.bandwidthUsed += result.size;
    if (result.viaProxy) this.stats.viaProxy++;
    else this.stats.viaDirect++;
    this.stats.queueSize = await getQueueSize();

    // Publish SIP-01 v1.1 observation to the shared index (kind 39697).
    // Canonical spec: https://github.com/NostrDanish/SIP-01
    // When no relay accepts it, the event waits in the outbox — a dead
    // network never costs the network an observation.
    const host = new URL(job.url).hostname;
    const platform = detectPlatform(host);
    const published = await publishIndexObservation({
      url: job.url,
      title: parsed.title,
      description: parsed.description,
      image: parsed.image,
      language: parsed.language,
      published: parsed.published,
      source: 'indexstr/1',
      // Extension registry (spec §9.2): a browser crawler only ever sees clearnet.
      network: 'clearnet',
      ...(platform ? { platform } : {}),
      type: platform === 'github' || platform === 'gitlab' ? 'repository' : 'page',
    });
    if (published) {
      if (published.delivered > 0) this.stats.published++;
      this.stats.outboxPending = await getOutboxSize();
    }

    // Self-expanding index: discovered links enter the queue sharded like
    // everything else, so organic growth is distributed across nodes too.
    // (Collection-seeded jobs index the exact URL only — their crawl plan
    // is already curated.)
    if (job.followLinks !== false && job.depth < this.settings.maxDepth) {
      const maxLinks = this.settings.ecoMode ? 5 : 10;
      let added = 0;
      for (const link of parsed.links.slice(0, maxLinks)) {
        const normalized = normalizeIndexUrl(link);
        if (!normalized) continue;

        // Don't re-crawl same URL
        if (normalized === job.url) continue;

        await addToQueue({
          url: normalized,
          priority: job.priority * 0.8,
          depth: job.depth + 1,
          discoveredFrom: job.url,
          attempts: 0,
          shard: urlShard(normalized),
        });
        added++;
      }
      this.stats.discovered += added;
      this.stats.queueSize = await getQueueSize();
      this.stats.homeShardJobs = await getQueueShardCount(this.homeShard);
    }
  }

  private async canCrawl(): Promise<boolean> {
    // Check battery
    if ('getBattery' in navigator) {
      try {
        const battery = await (navigator as unknown as { getBattery(): Promise<{ level: number; charging: boolean }> }).getBattery();
        if (battery.level < 0.15 && !battery.charging) {
          return false;
        }
        if (this.settings.chargingOnly && !battery.charging) {
          return false;
        }
      } catch {
        // Battery API not available, continue
      }
    }

    // Check network
    if ('connection' in navigator) {
      const conn = (navigator as unknown as { connection?: { effectiveType?: string; type?: string } }).connection;
      if (conn?.effectiveType === 'slow-2g' || conn?.effectiveType === '2g') {
        return false;
      }
      if (this.settings.wifiOnly && conn?.type !== 'wifi' && conn?.effectiveType !== '4g') {
        return false;
      }
    }

    // Check bandwidth limit
    if (this.stats.bandwidthUsed > this.settings.maxBandwidthMB * 1024 * 1024) {
      return false;
    }

    return true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timeout = setTimeout(resolve, ms);
      this.abortController?.signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}
