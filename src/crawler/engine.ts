// Main crawler engine — orchestrates the crawl loop
// Publishes SIP-01 (kind 39697) web index observations via the shared protocol

import { fetchPage } from './fetcher';
import { parsePage } from './parser';
import { normalizeIndexUrl } from './webIndex';
import { hashContent } from './hasher';
import { shouldCrawlUrl, getCrawlDelay } from './robots';
import { canMakeRequest } from './limits';
import { publishIndexObservation } from './publisher';
import {
  initDB,
  addToQueue,
  addManyToQueue,
  getNextJob,
  removeFromQueue,
  getQueueSize,
  getCrawled,
  markCrawled,
  findByHash,
  getCrawledCount,
  getCrawledUrlSet,
  getRecentCrawled,
  clearQueue,
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
  };
  private abortController: AbortController | null = null;
  private onStatsChange?: (stats: CrawlerStats) => void;

  constructor(settings?: Partial<CrawlerSettings>) {
    const stored = localStorage.getItem('indexstr-settings');
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(stored ? JSON.parse(stored) : {}),
      ...settings,
    };
  }

  async init(): Promise<void> {
    await initDB();
    this.stats.queueSize = await getQueueSize();
    this.stats.pagesIndexed = await getCrawledCount();
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
    this.crawlLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    this.emitStats();
  }

  isRunning(): boolean {
    return this.running;
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
    });
    this.stats.queueSize = await getQueueSize();
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
      });
    }
    await addManyToQueue(jobs, onProgress);
    this.stats.queueSize = await getQueueSize();
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

        const job = await getNextJob();
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
    const host = new URL(job.url).hostname;
    const platform = detectPlatform(host);
    await publishIndexObservation({
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

    // Add discovered links to queue (collection-seeded jobs index the exact
    // URL only — their crawl plan is already curated)
    if (job.followLinks !== false && job.depth < this.settings.maxDepth) {
      const maxLinks = this.settings.ecoMode ? 5 : 10;
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
        });
      }
      this.stats.queueSize = await getQueueSize();
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
