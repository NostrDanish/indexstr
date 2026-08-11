// IndexedDB-backed crawl queue + observation outbox
//
// v2 adds:
//   - `shard` on every CrawlJob + a by-shard index, so the scheduler can
//     prefer the node's home shard (deterministic distributed assignment)
//   - an `outbox` store holding signed kind 39697 events that could not be
//     published (all relays unreachable). Local-first rule: crawl progress
//     is never lost because the network is down — events flush on retry.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { NostrEvent } from '@nostrify/nostrify';
import type { CrawlJob } from './types';

interface CrawlerDB extends DBSchema {
  queue: {
    key: string;
    value: CrawlJob;
    indexes: { 'by-priority': number; 'by-shard': number };
  };
  crawled: {
    key: string;
    value: {
      url: string;
      contentHash: string;
      title: string;
      crawledAt: number;
    };
    indexes: { 'by-hash': string };
  };
  outbox: {
    key: number;
    value: {
      event: NostrEvent;
      queuedAt: number;
    };
  };
}

/** Upper bound for held observations — a full outbox drops oldest-first logic
 *  in favor of simply not storing more (they can be re-crawled later). */
export const OUTBOX_MAX = 5000;

let db: IDBPDatabase<CrawlerDB> | null = null;

export async function initDB(): Promise<IDBPDatabase<CrawlerDB>> {
  if (db) return db;

  db = await openDB<CrawlerDB>('indexstr-crawler', 2, {
    upgrade(database, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        const queueStore = database.createObjectStore('queue', { keyPath: 'url' });
        queueStore.createIndex('by-priority', 'priority');

        const crawledStore = database.createObjectStore('crawled', { keyPath: 'url' });
        crawledStore.createIndex('by-hash', 'contentHash');
      }
      if (oldVersion < 2) {
        const queueStore = tx.objectStore('queue');
        if (!queueStore.indexNames.contains('by-shard')) {
          queueStore.createIndex('by-shard', 'shard');
        }
        if (!database.objectStoreNames.contains('outbox')) {
          database.createObjectStore('outbox', { autoIncrement: true });
        }
      }
    },
  });

  return db;
}

export async function addToQueue(job: CrawlJob): Promise<void> {
  const database = await initDB();
  await database.put('queue', job);
}

/**
 * Bulk-insert jobs in chunked transactions. Used when seeding a curated
 * collection, which can mean tens of thousands of URLs at once.
 */
export async function addManyToQueue(
  jobs: CrawlJob[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const database = await initDB();
  const CHUNK = 2000;
  for (let i = 0; i < jobs.length; i += CHUNK) {
    const tx = database.transaction('queue', 'readwrite');
    for (const job of jobs.slice(i, i + CHUNK)) {
      void tx.store.put(job);
    }
    await tx.done;
    onProgress?.(Math.min(i + CHUNK, jobs.length), jobs.length);
  }
}

/**
 * Pick the next job.
 *
 * Shard-preferential scheduling: with probability (1 - crossSample) the job
 * comes from the node's home shard; otherwise from the whole queue. Either
 * way the highest-priority ready job wins. Jobs whose `nextAttempt` is in
 * the future are skipped (bounded scan, then fall through to the other pool
 * so a throttled home shard doesn't stall the node).
 */
export async function getNextJob(
  homeShard?: number,
  crossSample = 0.25,
): Promise<CrawlJob | null> {
  const database = await initDB();

  const tryIndex = async (useHome: boolean): Promise<CrawlJob | null> => {
    const tx = database.transaction('queue', 'readonly');
    const index = tx.store.index(useHome ? 'by-shard' : 'by-priority');
    const direction = useHome ? 'next' : 'prev';

    if (useHome && homeShard === undefined) return null;

    // Home shard: iterate its jobs and keep the highest-priority ready one.
    // Global pool: priority order already; take the first ready job.
    let best: CrawlJob | null = null;
    let cursor = await index.openCursor(
      useHome && homeShard !== undefined ? IDBKeyRange.only(homeShard) : null,
      direction,
    );
    let scanned = 0;
    while (cursor && scanned < 500) {
      scanned++;
      const job = cursor.value;
      const ready = !job.nextAttempt || Date.now() >= job.nextAttempt;
      if (ready) {
        if (!useHome) return job; // by-priority is already ordered
        if (!best || job.priority > best.priority) best = job;
      }
      cursor = await cursor.continue();
    }
    return best;
  };

  const wantHome =
    homeShard !== undefined && Math.random() >= crossSample;

  if (wantHome) {
    const home = await tryIndex(true);
    if (home) return home;
  }
  return tryIndex(false);
}

export async function removeFromQueue(url: string): Promise<void> {
  const database = await initDB();
  await database.delete('queue', url);
}

export async function getQueueSize(): Promise<number> {
  const database = await initDB();
  return database.count('queue');
}

/** How many queued jobs belong to a shard (for the node UI). */
export async function getQueueShardCount(shard: number): Promise<number> {
  const database = await initDB();
  const tx = database.transaction('queue', 'readonly');
  return tx.store.index('by-shard').count(IDBKeyRange.only(shard));
}

export async function getCrawled(url: string) {
  const database = await initDB();
  return database.get('crawled', url);
}

export async function markCrawled(url: string, contentHash: string, title: string): Promise<void> {
  const database = await initDB();
  await database.put('crawled', {
    url,
    contentHash,
    title,
    crawledAt: Date.now(),
  });
}

export async function findByHash(hash: string): Promise<string | null> {
  const database = await initDB();
  const tx = database.transaction('crawled', 'readonly');
  const index = tx.store.index('by-hash');
  const result = await index.get(hash);
  return result?.url ?? null;
}

export async function getCrawledCount(): Promise<number> {
  const database = await initDB();
  return database.count('crawled');
}

/** Every URL that has already been crawled — for bulk dedup during seeding. */
export async function getCrawledUrlSet(): Promise<Set<string>> {
  const database = await initDB();
  const keys = await database.getAllKeys('crawled');
  return new Set(keys);
}

export async function getRecentCrawled(limit = 20) {
  const database = await initDB();
  const tx = database.transaction('crawled', 'readonly');
  const all = await tx.store.getAll();
  return all
    .sort((a, b) => b.crawledAt - a.crawledAt)
    .slice(0, limit);
}

export async function clearQueue(): Promise<void> {
  const database = await initDB();
  await database.clear('queue');
}

/* ------------------------------------------------------------------------ */
/* Observation outbox (offline-first publishing)                             */
/* ------------------------------------------------------------------------ */

/** Hold a signed observation until relays are reachable again. */
export async function enqueueOutbox(event: NostrEvent): Promise<void> {
  const database = await initDB();
  const count = await database.count('outbox');
  if (count >= OUTBOX_MAX) return; // bound memory; re-crawl can reproduce it
  await database.add('outbox', { event, queuedAt: Date.now() });
}

/** Number of observations waiting for relay connectivity. */
export async function getOutboxSize(): Promise<number> {
  const database = await initDB();
  return database.count('outbox');
}

/**
 * Drain the outbox through `publish`. Stops at the first failure so a dead
 * network doesn't burn retries; entries are removed only after success.
 * Returns how many were published.
 */
export async function flushOutbox(
  publish: (event: NostrEvent) => Promise<boolean>,
): Promise<number> {
  const database = await initDB();
  let published = 0;

  for (;;) {
    const tx = database.transaction('outbox', 'readonly');
    const cursor = await tx.store.openCursor();
    if (!cursor) break;
    const key = cursor.primaryKey;
    const { event } = cursor.value;

    const ok = await publish(event);
    if (!ok) break;

    await database.delete('outbox', key);
    published++;
  }

  return published;
}
