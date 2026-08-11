// IndexedDB-backed crawl queue

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CrawlJob } from './types';

interface CrawlerDB extends DBSchema {
  queue: {
    key: string;
    value: CrawlJob;
    indexes: { 'by-priority': number };
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
}

let db: IDBPDatabase<CrawlerDB> | null = null;

export async function initDB(): Promise<IDBPDatabase<CrawlerDB>> {
  if (db) return db;

  db = await openDB<CrawlerDB>('indexstr-crawler', 1, {
    upgrade(database) {
      const queueStore = database.createObjectStore('queue', { keyPath: 'url' });
      queueStore.createIndex('by-priority', 'priority');

      const crawledStore = database.createObjectStore('crawled', { keyPath: 'url' });
      crawledStore.createIndex('by-hash', 'contentHash');
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

/** Every URL that has already been crawled — for bulk dedup during seeding. */
export async function getCrawledUrlSet(): Promise<Set<string>> {
  const database = await initDB();
  const keys = await database.getAllKeys('crawled');
  return new Set(keys);
}

export async function getNextJob(): Promise<CrawlJob | null> {
  const database = await initDB();
  const tx = database.transaction('queue', 'readonly');
  const index = tx.store.index('by-priority');
  const cursor = await index.openCursor(null, 'prev'); // Highest priority first

  if (!cursor) return null;

  const job = cursor.value;

  // Check if we should wait
  if (job.nextAttempt && Date.now() < job.nextAttempt) {
    return null;
  }

  return job;
}

export async function removeFromQueue(url: string): Promise<void> {
  const database = await initDB();
  await database.delete('queue', url);
}

export async function getQueueSize(): Promise<number> {
  const database = await initDB();
  return database.count('queue');
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
