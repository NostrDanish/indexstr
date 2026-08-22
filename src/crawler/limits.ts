// Rate limiting: per-domain delay + a global pages/hour sliding window.
//
// The engine's crawl loop is serial (maxConcurrent: 1 by construction — one
// job is processed at a time), so the per-domain map needs no reservation
// machinery. If the loop ever gains workers, replace the map check-then-set
// with per-origin token buckets FIRST — the two steps are not atomic.

const domainLastRequest = new Map<string, number>();
const DEFAULT_RATE_LIMIT = 5000; // 5 seconds between requests per domain

export async function canMakeRequest(url: string, customDelay?: number): Promise<boolean> {
  const domain = new URL(url).hostname;
  const lastRequest = domainLastRequest.get(domain) ?? 0;
  const now = Date.now();
  const rateLimit = customDelay ?? DEFAULT_RATE_LIMIT;

  if (now - lastRequest < rateLimit) {
    return false; // Too soon
  }

  domainLastRequest.set(domain, now);
  return true;
}

export function getTimeUntilNextRequest(url: string, customDelay?: number): number {
  const domain = new URL(url).hostname;
  const lastRequest = domainLastRequest.get(domain) ?? 0;
  const rateLimit = customDelay ?? DEFAULT_RATE_LIMIT;
  const elapsed = Date.now() - lastRequest;
  return Math.max(0, rateLimit - elapsed);
}

/* ------------------------------------------------------------------------ */
/* Global pages/hour sliding window (session-scoped)                         */
/* ------------------------------------------------------------------------ */

const HOUR_MS = 3_600_000;
let fetchTimestamps: number[] = [];

/** Record that a page fetch was attempted (success or failure). */
export function recordFetchAttempt(now = Date.now()): void {
  fetchTimestamps.push(now);
  // Prune inline so the array stays small.
  if (fetchTimestamps.length > 4096) {
    fetchTimestamps = fetchTimestamps.filter((t) => now - t < HOUR_MS);
  }
}

/** True when the configured pages/hour budget is exhausted. */
export function pagesPerHourExceeded(limit: number, now = Date.now()): boolean {
  if (limit <= 0) return false; // 0 = unlimited
  const cutoff = now - HOUR_MS;
  let count = 0;
  for (let i = fetchTimestamps.length - 1; i >= 0; i--) {
    if (fetchTimestamps[i] < cutoff) break;
    count++;
    if (count >= limit) return true;
  }
  return false;
}

export function resetLimits(): void {
  domainLastRequest.clear();
  fetchTimestamps = [];
}
