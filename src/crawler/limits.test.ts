import { describe, expect, test, beforeEach } from 'vitest';
import {
  canMakeRequest,
  pagesPerHourExceeded,
  recordFetchAttempt,
  resetLimits,
} from './limits';

describe('per-domain rate limit', () => {
  beforeEach(() => resetLimits());

  test('second request inside the window is refused', async () => {
    expect(await canMakeRequest('https://example.com/a', 50)).toBe(true);
    expect(await canMakeRequest('https://example.com/b', 50)).toBe(false);
  });

  test('different domains are independent', async () => {
    expect(await canMakeRequest('https://a.com/', 50)).toBe(true);
    expect(await canMakeRequest('https://b.com/', 50)).toBe(true);
  });

  test('window expiry releases the domain', async () => {
    expect(await canMakeRequest('https://example.com/', 30)).toBe(true);
    await new Promise((r) => setTimeout(r, 45));
    expect(await canMakeRequest('https://example.com/', 30)).toBe(true);
  });
});

describe('pages/hour sliding window', () => {
  beforeEach(() => resetLimits());

  test('not exceeded below the limit', () => {
    const now = Date.now();
    for (let i = 0; i < 99; i++) recordFetchAttempt(now - i * 1000);
    expect(pagesPerHourExceeded(100, now)).toBe(false);
  });

  test('exceeded at the limit', () => {
    const now = Date.now();
    for (let i = 0; i < 100; i++) recordFetchAttempt(now - i * 1000);
    expect(pagesPerHourExceeded(100, now)).toBe(true);
  });

  test('old attempts fall out of the window', () => {
    const now = Date.now();
    // 100 attempts two hours ago — should NOT count.
    for (let i = 0; i < 100; i++) recordFetchAttempt(now - 2 * 3_600_000 - i * 1000);
    recordFetchAttempt(now);
    expect(pagesPerHourExceeded(100, now)).toBe(false);
  });

  test('limit 0 means unlimited', () => {
    const now = Date.now();
    for (let i = 0; i < 5000; i++) recordFetchAttempt(now - i * 100);
    expect(pagesPerHourExceeded(0, now)).toBe(false);
  });
});
