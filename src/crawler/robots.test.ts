import { beforeEach, describe, expect, test, vi } from 'vitest';
import { shouldCrawlUrl, getCrawlDelay } from './robots';

/**
 * robots.ts SSRF defense-in-depth: robots.txt must NEVER be fetched from a
 * private host (direct or via the CORS proxy), no matter what the caller
 * did. Robots-on-private-host is a refusal, not "allowed".
 */
describe('robots SSRF guard', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  test('private hosts are refused without any fetch', async () => {
    expect(await shouldCrawlUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(await shouldCrawlUrl('http://127.0.0.1/admin')).toBe(false);
    expect(await shouldCrawlUrl('http://[::ffff:127.0.0.1]/x')).toBe(false);
    expect(await shouldCrawlUrl('http://[64:ff9b::a9fe:a9fe]/x')).toBe(false);
    expect(await shouldCrawlUrl('http://192.168.0.1/')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('getCrawlDelay never fetches robots for private hosts', async () => {
    expect(await getCrawlDelay('http://10.0.0.5/page')).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('public host with no robots.txt (404) is allowed', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    expect(await shouldCrawlUrl('https://robots-404.example/page')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // direct attempt only
  });

  test('public host Disallow rule is honoured', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => 'User-agent: *\nDisallow: /private\nCrawl-delay: 2\n',
    });
    expect(await shouldCrawlUrl('https://robots-rules.example/private/x')).toBe(false);
    expect(await shouldCrawlUrl('https://robots-rules.example/public/x')).toBe(true);
    expect(await getCrawlDelay('https://robots-rules.example/public/x')).toBe(2000);
  });
});
