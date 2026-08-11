/**
 * Curated URL collections — the reason Indexstr exists.
 *
 * Each collection ships as a raw SQLite database in /public/collections and
 * holds a `linkdatamodel` table (scraped links with titles) plus a
 * `sourcedatamodel` table (categorized source sites/feeds). The loader
 * fetches the database on demand, scans both tables with the minimal SQLite
 * reader (sqlite.ts), normalizes every URL per SIP-01 §7, dedupes, and
 * returns a clean seed list for the crawl queue.
 *
 * Databases are parsed once and the extracted URL list is cached in
 * IndexedDB, so reloading a collection later is instant.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { SqliteReader } from './sqlite';
import { normalizeIndexUrl } from './webIndex';

/* ------------------------------------------------------------------------ */
/* Registry                                                                  */
/* ------------------------------------------------------------------------ */

export interface UrlCollection {
  /** Stable id — also the file name: /public/collections/<id>.db */
  id: string;
  name: string;
  description: string;
  /** Lucide icon key, resolved by the UI. */
  icon: string;
  /** File size in bytes (shown before first load). */
  sizeBytes: number;
}

export const COLLECTIONS: UrlCollection[] = [
  {
    id: 'top',
    name: 'Top Sites',
    description: 'High-traffic websites, news aggregators and community threads.',
    icon: 'trophy',
    sizeBytes: 26099712,
  },
  {
    id: 'awesomelists',
    name: 'Awesome Lists',
    description: 'Curated awesome-* lists — the best tools and resources per topic.',
    icon: 'list-checks',
    sizeBytes: 20488192,
  },
  {
    id: 'feeds',
    name: 'RSS Feeds',
    description: 'RSS and Atom feeds across tech, science, news and culture.',
    icon: 'rss',
    sizeBytes: 18808832,
  },
  {
    id: 'music',
    name: 'Music',
    description: 'Artists, labels, streaming pages and music communities.',
    icon: 'music',
    sizeBytes: 10416128,
  },
  {
    id: 'books',
    name: 'Books',
    description: 'Digital libraries, book search engines and reading platforms.',
    icon: 'book-open',
    sizeBytes: 1327104,
  },
  {
    id: 'movies',
    name: 'Movies',
    description: 'Film databases, streaming indexes and cinema resources.',
    icon: 'clapperboard',
    sizeBytes: 1204224,
  },
  {
    id: 'memes',
    name: 'Memes',
    description: 'Meme archives, humor sites and internet culture pages.',
    icon: 'laugh',
    sizeBytes: 1052672,
  },
  {
    id: 'videogames',
    name: 'Video Games',
    description: 'Game databases, stores, mods and gaming communities.',
    icon: 'gamepad-2',
    sizeBytes: 884736,
  },
];

/* ------------------------------------------------------------------------ */
/* Types + progress                                                          */
/* ------------------------------------------------------------------------ */

export interface CollectionSample {
  url: string;
  title?: string;
}

export interface CollectionEntries {
  /** Normalized, deduped URLs ready for the crawl queue. */
  urls: string[];
  /** A few titled entries for UI previews. */
  samples: CollectionSample[];
  /** Rows scanned before normalization/dedup. */
  rawCount: number;
}

export type LoadStage = 'downloading' | 'parsing' | 'cached';

export type LoadProgress =
  | { stage: 'downloading'; loaded: number; total: number }
  | { stage: 'parsing'; pages: number; totalPages: number }
  | { stage: 'cached' };

/* ------------------------------------------------------------------------ */
/* Extraction cache (IndexedDB)                                              */
/* ------------------------------------------------------------------------ */

interface CollectionsDB extends DBSchema {
  'collection-cache': {
    key: string;
    value: {
      id: string;
      urls: string[];
      samples: CollectionSample[];
      rawCount: number;
      extractedAt: number;
    };
  };
}

let cacheDb: IDBPDatabase<CollectionsDB> | null = null;

async function getCacheDb(): Promise<IDBPDatabase<CollectionsDB>> {
  if (cacheDb) return cacheDb;
  cacheDb = await openDB<CollectionsDB>('indexstr-collections', 1, {
    upgrade(database) {
      database.createObjectStore('collection-cache', { keyPath: 'id' });
    },
  });
  return cacheDb;
}

export async function getCachedCollection(id: string): Promise<CollectionEntries | null> {
  try {
    const db = await getCacheDb();
    const hit = await db.get('collection-cache', id);
    return hit ? { urls: hit.urls, samples: hit.samples, rawCount: hit.rawCount } : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------ */
/* Loader                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Fetch and parse a collection database. Extraction results are cached in
 * IndexedDB; pass `fresh: true` to force a re-download + re-parse.
 */
export async function loadCollectionEntries(
  collection: UrlCollection,
  onProgress?: (progress: LoadProgress) => void,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<CollectionEntries> {
  if (!fresh) {
    const cached = await getCachedCollection(collection.id);
    if (cached && cached.urls.length > 0) {
      onProgress?.({ stage: 'cached' });
      return cached;
    }
  }

  // 1. Download the database, reporting byte progress.
  const response = await fetch(`/collections/${collection.id}.db`);
  if (!response.ok) throw new Error(`Failed to fetch collection (${response.status})`);

  const total = Number(response.headers.get('content-length')) || collection.sizeBytes;
  let buffer: ArrayBuffer;
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.({ stage: 'downloading', loaded, total });
    }
    const merged = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    buffer = merged.buffer;
  } else {
    buffer = await response.arrayBuffer();
  }

  // 2. Parse: full-scan linkdatamodel (scraped links) and sourcedatamodel
  //    (categorized sources) and merge.
  const db = new SqliteReader(buffer);
  const tables = new Map(db.listTables().map((t) => [t.name, t]));

  const seen = new Set<string>();
  const urls: string[] = [];
  const samples: CollectionSample[] = [];
  let rawCount = 0;

  const addUrl = (raw: unknown, title: unknown, description: unknown): void => {
    if (typeof raw !== 'string' || raw.length === 0) return;
    rawCount++;

    // Clean scraper artifacts: "URL:<link>" prefixes and literal whitespace
    // (a space means the scraper glued an error message onto the URL).
    let candidate = raw.trim();
    if (/^url:/i.test(candidate)) candidate = candidate.slice(4).trim();
    if (/\s/.test(candidate) || candidate.length < 10) return;

    const normalized = normalizeIndexUrl(candidate);
    if (!normalized || normalized.length > 2048) return;
    if (!isIndexableHost(normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    urls.push(normalized);

    if (
      samples.length < 8 &&
      typeof title === 'string' &&
      title.trim().length > 2 &&
      !/\b(response is invalid|error|not found)\b/i.test(title)
    ) {
      samples.push({
        url: normalized,
        title: title.trim().slice(0, 120) || undefined,
      });
    }
    void description; // Titles are enough for previews; content comes from crawling.
  };

  const progress = (pages: number, totalPages: number) =>
    onProgress?.({ stage: 'parsing', pages, totalPages });

  const links = tables.get('linkdatamodel');
  if (links) {
    const cols = SqliteReader.tableColumns(links.sql);
    const iLink = cols.indexOf('link');
    const iTitle = cols.indexOf('title');
    const iDesc = cols.indexOf('description');
    if (iLink >= 0) {
      await db.scanTable(
        links.rootPage,
        (values) => addUrl(values[iLink], iTitle >= 0 ? values[iTitle] : null, iDesc >= 0 ? values[iDesc] : null),
        progress,
      );
    }
  }

  const sources = tables.get('sourcedatamodel');
  if (sources) {
    const cols = SqliteReader.tableColumns(sources.sql);
    const iUrl = cols.indexOf('url');
    const iTitle = cols.indexOf('title');
    if (iUrl >= 0) {
      await db.scanTable(
        sources.rootPage,
        (values) => addUrl(values[iUrl], iTitle >= 0 ? values[iTitle] : null, null),
        progress,
      );
    }
  }

  // 3. Cache the extraction so the next load is instant.
  try {
    const cache = await getCacheDb();
    await cache.put('collection-cache', {
      id: collection.id,
      urls,
      samples,
      rawCount,
      extractedAt: Date.now(),
    });
  } catch {
    // Cache is best-effort — seeding still works without it.
  }

  return { urls, samples, rawCount };
}

/**
 * Drop URLs a browser crawler can never reach: localhost, private ranges,
 * dotless hosts, and non-clearnet TLDs (.onion/.i2p resolve nowhere here).
 */
function isIndexableHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (!host.includes('.')) return false;
    if (host === 'localhost' || host.endsWith('.local')) return false;
    if (host.endsWith('.onion') || host.endsWith('.i2p')) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      if (/^(127\.|10\.|192\.168\.|0\.)/.test(host)) return false;
      const [, second] = host.split('.').map(Number);
      if (host.startsWith('172.') && second >= 16 && second <= 31) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------ */
/* Loaded-state bookkeeping (localStorage)                                   */
/* ------------------------------------------------------------------------ */

const LS_KEY = 'indexstr:collection-state:v1';

export interface CollectionState {
  /** URLs queued the last time this collection was loaded. */
  queued: number;
  loadedAt: number;
}

export function getCollectionStates(): Record<string, CollectionState> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, CollectionState>) : {};
  } catch {
    return {};
  }
}

export function markCollectionLoaded(id: string, queued: number): Record<string, CollectionState> {
  const states = getCollectionStates();
  states[id] = { queued, loadedAt: Date.now() };
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(states));
  } catch {
    // Non-critical.
  }
  return states;
}
