import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import type { CrawlJob } from './types';
import type { IndexerIntakeGuard } from './traps';

/**
 * Engine-level security tests: SSRF ordering (no fetch of any kind for
 * private hosts) and intake economics (dedup before budget charging).
 *
 * All network/DB edges are mocked — these tests assert ORDERING and
 * ADMISSION, not parsing.
 */

const { fetchPageMock, shouldCrawlUrlMock, queueMocks } = vi.hoisted(() => ({
  fetchPageMock: vi.fn(),
  shouldCrawlUrlMock: vi.fn(),
  queueMocks: {
    addToQueue: vi.fn(),
    removeFromQueue: vi.fn(),
    isQueued: vi.fn(),
    getQueueSize: vi.fn(),
    getQueueShardCount: vi.fn(),
    getCrawled: vi.fn(),
    getCrawledUrlSet: vi.fn(),
  },
}));

vi.mock('./fetcher', () => ({
  fetchPage: fetchPageMock,
  SsrRefusal: class SsrRefusal extends Error {
    constructor(url: string) {
      super(`SSRF refusal: ${url}`);
      this.name = 'SsrRefusal';
    }
  },
  CORS_PROXY_TEMPLATE: 'https://proxy.example/?url={href}',
}));

vi.mock('./robots', () => ({
  shouldCrawlUrl: shouldCrawlUrlMock,
  getCrawlDelay: vi.fn(async () => 0),
}));

vi.mock('./queue', () => ({
  initDB: vi.fn(async () => {}),
  addToQueue: queueMocks.addToQueue,
  addManyToQueue: vi.fn(async () => {}),
  getNextJob: vi.fn(async () => null),
  removeFromQueue: queueMocks.removeFromQueue,
  getQueueSize: queueMocks.getQueueSize,
  getQueueShardCount: queueMocks.getQueueShardCount,
  getCrawled: queueMocks.getCrawled,
  markCrawled: vi.fn(async () => {}),
  findByHash: vi.fn(async () => undefined),
  getCrawledCount: vi.fn(async () => 0),
  getCrawledUrlSet: queueMocks.getCrawledUrlSet,
  getRecentCrawled: vi.fn(async () => []),
  clearQueue: vi.fn(async () => {}),
  getOutboxSize: vi.fn(async () => 0),
  isQueued: queueMocks.isQueued,
}));

vi.mock('./publisher', () => ({
  publishIndexObservation: vi.fn(async () => ({ delivered: 0 })),
  flushObservationOutbox: vi.fn(async () => 0),
  getRelayHealth: vi.fn(() => ({})),
}));

import { CrawlerEngine, setNetworkQuerier } from './engine';
import { SIP01_KIND } from './webIndex';

/** Type-safe handle to private engine internals — no `any`. */
interface EngineInternals {
  crawlUrl(job: CrawlJob): Promise<void>;
  networkIntake(): Promise<void>;
  running: boolean;
  indexerGuard: IndexerIntakeGuard;
}
const internals = (engine: CrawlerEngine): EngineInternals =>
  engine as unknown as EngineInternals;

function makeJob(url: string): CrawlJob {
  return { url, priority: 1, depth: 0, attempts: 0, followLinks: false };
}

function makeEvent(pubkey: string, url: string, id: string): NostrEvent {
  return {
    id,
    pubkey,
    kind: SIP01_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', `widx:${id}`],
      ['u', url],
    ],
    content: '',
    sig: '00',
  };
}

describe('crawlUrl SSRF ordering (F1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueMocks.getCrawled.mockResolvedValue(undefined);
    queueMocks.getQueueSize.mockResolvedValue(0);
    shouldCrawlUrlMock.mockResolvedValue(true);
  });

  test('private-host job issues NO fetch — not robots, not the page', async () => {
    const engine = new CrawlerEngine({ respectRobots: true });
    await internals(engine).crawlUrl(makeJob('http://169.254.169.254/latest/meta-data'));

    expect(shouldCrawlUrlMock).not.toHaveBeenCalled();
    expect(fetchPageMock).not.toHaveBeenCalled();
    expect(queueMocks.removeFromQueue).toHaveBeenCalledWith('http://169.254.169.254/latest/meta-data');
    expect(engine.getStats().ssrfBlocked).toBe(1);
    expect(engine.getStats().skipped).toBe(1);
  });

  test('IPv6-bypass private job is refused before any request too', async () => {
    const engine = new CrawlerEngine({ respectRobots: true });
    await internals(engine).crawlUrl(makeJob('http://[64:ff9b::a9fe:a9fe]/x'));

    expect(shouldCrawlUrlMock).not.toHaveBeenCalled();
    expect(fetchPageMock).not.toHaveBeenCalled();
    expect(engine.getStats().ssrfBlocked).toBe(1);
  });

  test('public job still checks robots BEFORE fetching the page', async () => {
    fetchPageMock.mockResolvedValue(null); // reachable-but-unusable: stop there
    const engine = new CrawlerEngine({ respectRobots: true });
    await internals(engine).crawlUrl(makeJob('https://example.com/article'));

    expect(shouldCrawlUrlMock).toHaveBeenCalledTimes(1);
    expect(fetchPageMock).toHaveBeenCalledTimes(1);
    expect(shouldCrawlUrlMock.mock.invocationCallOrder[0])
      .toBeLessThan(fetchPageMock.mock.invocationCallOrder[0]);
    expect(engine.getStats().ssrfBlocked).toBe(0);
  });
});

describe('network intake SSRF admission (F1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueMocks.getQueueSize.mockResolvedValue(0);
    queueMocks.getQueueShardCount.mockResolvedValue(0);
    queueMocks.getCrawledUrlSet.mockResolvedValue(new Set<string>());
    queueMocks.isQueued.mockResolvedValue(false);
  });

  test('private-host observation is rejected at admission, never queued', async () => {
    const url = 'http://169.254.169.254/latest/meta-data';
    setNetworkQuerier(async () => [makeEvent('aa'.repeat(32), url, '11'.repeat(32))]);

    const engine = new CrawlerEngine();
    internals(engine).running = true;
    await internals(engine).networkIntake();

    expect(queueMocks.addToQueue).not.toHaveBeenCalled();
    expect(engine.getStats().intakeRejected).toBe(1);
    expect(engine.getStats().ssrfBlocked).toBe(1);
  });

  test('public observation is admitted and queued', async () => {
    const url = 'https://example.com/interesting';
    setNetworkQuerier(async () => [makeEvent('bb'.repeat(32), url, '22'.repeat(32))]);

    const engine = new CrawlerEngine();
    internals(engine).running = true;
    await internals(engine).networkIntake();

    expect(queueMocks.addToQueue).toHaveBeenCalledTimes(1);
    expect(engine.getStats().networkIntake).toBe(1);
  });
});

describe('network intake budget charging (F6)', () => {
  const victim = 'cc'.repeat(32);

  beforeEach(() => {
    vi.clearAllMocks();
    queueMocks.getQueueSize.mockResolvedValue(0);
    queueMocks.getQueueShardCount.mockResolvedValue(0);
    queueMocks.getCrawledUrlSet.mockResolvedValue(new Set<string>());
    queueMocks.isQueued.mockResolvedValue(false);
  });

  test('replayed duplicate observations do NOT burn the indexer budget', async () => {
    // 150 replays of the same already-queued URL from one indexer. The
    // per-indexer session cap is 100 — pre-fix, this exhausted the victim's
    // budget; now duplicates are filtered before any budget is charged.
    const url = 'https://example.com/already-queued';
    queueMocks.isQueued.mockResolvedValue(true); // everything is a duplicate
    const events = Array.from({ length: 150 }, (_, i) =>
      makeEvent(victim, url, String(i).padStart(4, '0').repeat(16)));
    setNetworkQuerier(async () => events);

    const engine = new CrawlerEngine();
    internals(engine).running = true;
    await internals(engine).networkIntake();

    expect(queueMocks.addToQueue).not.toHaveBeenCalled();
    // Budget fully intact: the victim can still contribute 100 fresh URLs.
    const guard = internals(engine).indexerGuard;
    for (let i = 0; i < 100; i++) expect(guard.allow(victim)).toBe(true);
    expect(guard.allow(victim)).toBe(false); // cap semantics unchanged
  });

  test('already-crawled duplicates do not burn budget either', async () => {
    const url = 'https://example.com/already-crawled';
    queueMocks.getCrawledUrlSet.mockResolvedValue(new Set([url]));
    const events = Array.from({ length: 120 }, (_, i) =>
      makeEvent(victim, url, String(i + 200).padStart(4, '0').repeat(16)));
    setNetworkQuerier(async () => events);

    const engine = new CrawlerEngine();
    internals(engine).running = true;
    await internals(engine).networkIntake();

    expect(queueMocks.addToQueue).not.toHaveBeenCalled();
    expect(internals(engine).indexerGuard.allow(victim)).toBe(true);
  });

  test('fresh URLs still charge the budget exactly once', async () => {
    const events = Array.from({ length: 3 }, (_, i) =>
      makeEvent(victim, `https://example.com/fresh-${i}`, String(i + 400).padStart(4, '0').repeat(16)));
    setNetworkQuerier(async () => events);

    const engine = new CrawlerEngine();
    internals(engine).running = true;
    await internals(engine).networkIntake();

    expect(queueMocks.addToQueue).toHaveBeenCalledTimes(3);
    const guard = internals(engine).indexerGuard;
    for (let i = 0; i < 97; i++) expect(guard.allow(victim)).toBe(true);
    expect(guard.allow(victim)).toBe(false); // 3 + 97 = 100 cap reached
  });
});
