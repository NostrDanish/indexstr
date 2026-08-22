// Crawler type definitions

export interface CrawlJob {
  url: string;
  priority: number;
  depth: number;
  discoveredFrom?: string;
  attempts: number;
  lastAttempt?: number;
  nextAttempt?: number;
  /**
   * Set to false to index only this exact URL without following its links.
   * Curated collections use this — the collection IS the crawl plan.
   */
  followLinks?: boolean;
  /**
   * Deterministic crawl-space shard (0–255, see sharding.ts). Assigned at
   * enqueue time; the scheduler prefers the node's home shard.
   */
  shard?: number;
}

export interface ParsedPage {
  title: string;
  description: string;
  /** Representative image (og:image / twitter:image). */
  image?: string;
  /** Claimed publication time, unix seconds (SIP-01 `published` tag). */
  published?: number;
  text: string;
  language: string;
  links: string[];
  wordCount: number;
  /** Site-supplied keywords (meta[name=keywords]) — source evidence. */
  keywords: string[];
  /** og:type, lowercased (article, website, video.other, …). */
  ogType?: string;
  /** JSON-LD @type values found on the page. */
  jsonLdTypes: string[];
  /** First few h1/h2 headings — classification evidence. */
  headings: string[];
}

/** A crawled-page record with freshness bookkeeping. */
export interface CrawledRecord {
  url: string;
  contentHash: string;
  title: string;
  crawledAt: number;
  /** Derived topics at last crawl (for the History UI). */
  topics?: string[];
  /** Unix ms — when the content hash last CHANGED. */
  lastChangedAt?: number;
  /** How often recrawls found changed content. */
  changeCount?: number;
  /** Consecutive recrawls with unchanged content. */
  unchangedStreak?: number;
  /** Unix ms — when this URL becomes eligible for recrawl. */
  recrawlDue?: number;
}

export interface CrawlResult {
  url: string;
  title: string;
  description: string;
  contentHash: string;
  language: string;
  links: string[];
  wordCount: number;
  crawledAt: number;
  status: number;
  contentType: string;
}

export interface CrawlerStats {
  pagesIndexed: number;
  queueSize: number;
  bandwidthUsed: number;
  uptime: number;
  errors: number;
  skipped: number;
  /** Pages that required the CORS proxy (most of the web). */
  viaProxy: number;
  /** Pages fetched directly because the site sends CORS headers. */
  viaDirect: number;
  /** Skipped because the site's robots.txt disallows crawling. */
  robotsBlocked: number;
  /** Could not be retrieved at all (network, proxy, timeout, non-HTML). */
  fetchFailed: number;
  /** Skipped because identical content was already indexed. */
  duplicates: number;
  /** Skipped for having almost no extractable text (JS-rendered SPAs). */
  thinContent: number;
  /** Observations accepted by at least one relay (this session). */
  published: number;
  /** Signed observations held for relay reconnect (offline-first). */
  outboxPending: number;
  /** New URLs discovered from crawled pages (this session). */
  discovered: number;
  /** Queued jobs in this node's home shard, when known. */
  homeShardJobs: number;
  /** URLs taken in from other indexers' network observations (this session). */
  networkIntake: number;
  /** Intake URLs rejected (trap/duplicate/cap/invalid — Sybil telemetry). */
  intakeRejected: number;
  /** Refused before any request: private/loopback/link-local target (SSRF). */
  ssrfBlocked: number;
  /** Discovered URLs rejected by crawl-trap heuristics (this session). */
  trapsBlocked: number;
}

export interface CrawlerSettings {
  wifiOnly: boolean;
  chargingOnly: boolean;
  respectRobots: boolean;
  /** Session bandwidth cap — enforced in canCrawl(). */
  maxBandwidthMB: number;
  /** Sliding-window global fetch budget — enforced in canCrawl(). */
  maxPagesPerHour: number;
  /** Link-follow depth for manual seeds — enforced at enqueue. */
  maxDepth: number;
  /** Serial by construction: the crawl loop processes one job at a time. */
  maxConcurrent: number;
  /** Passed to the fetcher, checked pre- and post-download. */
  maxPageSizeKB: number;
  ecoMode: boolean;
}

export const DEFAULT_SETTINGS: CrawlerSettings = {
  wifiOnly: false,
  chargingOnly: false,
  respectRobots: true,
  // 250 MB per browser session — collections are big, and silently stalling
  // at the old 25 MB cap looked like a broken crawler.
  maxBandwidthMB: 250,
  maxPagesPerHour: 100,
  maxDepth: 3,
  maxConcurrent: 1,
  maxPageSizeKB: 2048,
  ecoMode: true,
};
