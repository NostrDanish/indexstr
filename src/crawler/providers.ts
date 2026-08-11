/**
 * Seed provider abstraction — Indexstr's discovery layer is modular.
 *
 * Anything that can produce a stream of URLs is a SeedProvider: the bundled
 * SQLite collections, a pasted URL list, and (by design, later) RSS
 * watchers, git directory scrapers, community-published seed lists over
 * Nostr, or offline database importers. The crawler engine never cares
 * where URLs come from — it receives strings, normalizes, shards, and
 * queues them.
 *
 * To add a discovery source: implement SeedProvider and register it in
 * `seedProviders`. No crawler changes needed.
 */

import {
  loadCollectionEntries,
  type LoadProgress,
  type UrlCollection,
} from './collections';

export interface SeedProgress {
  stage: string;
  loaded?: number;
  total?: number;
}

export interface SeedProvider {
  /** Stable provider id. */
  id: string;
  /** Human label for logs/UI. */
  name: string;
  /**
   * Produce the provider's URLs. Implementations should normalize +
   * dedupe internally where cheap; the engine normalizes again regardless.
   */
  load(onProgress?: (progress: SeedProgress) => void): Promise<string[]>;
}

/** The bundled SQLite URL collections (see collections.ts). */
export class CollectionSeedProvider implements SeedProvider {
  readonly id: string;
  readonly name: string;

  constructor(private collection: UrlCollection) {
    this.id = `collection:${collection.id}`;
    this.name = collection.name;
  }

  async load(onProgress?: (progress: SeedProgress) => void): Promise<string[]> {
    const entries = await loadCollectionEntries(
      this.collection,
      (p: LoadProgress) => {
        if (p.stage === 'downloading') {
          onProgress?.({ stage: 'downloading', loaded: p.loaded, total: p.total });
        } else if (p.stage === 'parsing') {
          onProgress?.({ stage: 'parsing', loaded: p.pages, total: p.totalPages });
        } else {
          onProgress?.({ stage: 'cached' });
        }
      },
    );
    return entries.urls;
  }
}

/** URLs entered by hand in the dashboard. */
export class ManualSeedProvider implements SeedProvider {
  readonly id = 'manual';
  readonly name = 'Manual seeds';

  constructor(private urls: string[]) {}

  load(): Promise<string[]> {
    return Promise.resolve(this.urls);
  }
}

/**
 * Registry of available provider *types*. The bundled collections register
 * themselves from COLLECTIONS; future sources (RSS watchers, community
 * lists over Nostr, dataset importers) slot in here.
 */
export function collectionProviders(collections: UrlCollection[]): CollectionSeedProvider[] {
  return collections.map((c) => new CollectionSeedProvider(c));
}
