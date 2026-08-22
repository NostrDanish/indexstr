// HTTP fetcher.
//
// A browser cannot read cross-origin responses unless the target site sends
// CORS headers, and almost no site does. Direct fetches therefore fail with
// "TypeError: Failed to fetch" for the vast majority of the web, which made
// the crawler index nothing at all.
//
// Strategy: try direct first (fast, no third party sees the request), then
// fall back to a CORS proxy so the crawler actually works on real websites.
// The proxy is honest about the trade-off — see PROXY_NOTE below.
//
// SSRF: private/loopback/link-local targets are refused entirely (ssrf.ts) —
// never fetched directly AND never sent to the proxy (the proxy's network
// can reach infrastructure the browser's cannot). Redirect targets are
// re-checked on the final response URL.

import { isPrivateHost, isPrivateUrl } from './ssrf';

/** CORS proxy used when a direct cross-origin fetch is blocked. */
export const CORS_PROXY_TEMPLATE = 'https://proxy.shakespeare.diy/?url={href}';

/**
 * Honest disclosure for the UI: when the proxy is used, the proxy operator
 * sees which URL was fetched (not who searched for it, and no user identity).
 */
export const PROXY_NOTE =
  'When a site blocks direct browser access (CORS), the request is routed through a CORS proxy. The proxy operator can see which URLs are fetched.';

export interface FetchResult {
  html: string;
  status: number;
  contentType: string;
  size: number;
  /** True when the page had to be retrieved through the CORS proxy. */
  viaProxy: boolean;
}

export interface FetchOptions {
  maxSizeKB?: number;
  /** Allow falling back to the CORS proxy. Default true. */
  allowProxy?: boolean;
  timeoutMs?: number;
}

function proxyUrl(url: string): string {
  return CORS_PROXY_TEMPLATE.replace('{href}', encodeURIComponent(url));
}

/** Thrown when a fetch targets a private host — callers should not retry. */
export class SsrRefusal extends Error {
  constructor(url: string) {
    super(`SSRF refusal: ${url}`);
    this.name = 'SsrRefusal';
  }
}

interface RawFetch {
  html: string;
  status: number;
  contentType: string;
}

/** Single fetch attempt. Throws on network/CORS failure; returns null if unusable. */
async function attempt(
  requestUrl: string,
  maxSizeKB: number,
  timeoutMs: number,
): Promise<RawFetch | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(requestUrl, {
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.ok) return null;

    // Redirect → private target: discard. (For proxied requests response.url
    // is the proxy itself; the pre-send host block is the guard there.)
    if (response.redirected) {
      try {
        if (isPrivateHost(new URL(response.url).hostname)) return null;
      } catch {
        return null;
      }
    }

    const contentType = response.headers.get('content-type') ?? '';

    // Proxies sometimes omit/rewrite content-type. Accept empty and sniff later.
    const looksHtml =
      contentType === '' ||
      contentType.includes('text/html') ||
      contentType.includes('application/xhtml') ||
      contentType.includes('text/plain');
    if (!looksHtml) return null;

    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxSizeKB * 1024) return null;

    const html = await response.text();
    if (html.length > maxSizeKB * 1024) return null;

    // Sniff: make sure this is actually markup before handing it to the parser.
    if (!/<\s*(!doctype|html|head|body|title|meta|div|a|p)\b/i.test(html.slice(0, 4000))) {
      return null;
    }

    return { html, status: response.status, contentType: contentType || 'text/html' };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchPage(
  url: string,
  optionsOrMaxSizeKB: FetchOptions | number = {},
): Promise<FetchResult | null> {
  // SSRF guard: refuse private/loopback/link-local targets before ANY
  // request is issued — direct or proxied. The caller surfaces this as
  // `ssrfBlocked` (distinguished from an ordinary fetch failure).
  if (isPrivateUrl(url)) {
    throw new SsrRefusal(url);
  }

  const options: FetchOptions =
    typeof optionsOrMaxSizeKB === 'number'
      ? { maxSizeKB: optionsOrMaxSizeKB }
      : optionsOrMaxSizeKB;

  const maxSizeKB = options.maxSizeKB ?? 2048;
  const allowProxy = options.allowProxy ?? true;
  const timeoutMs = options.timeoutMs ?? 15000;

  // --- 1. Direct fetch (works only for CORS-enabled sites) ---
  try {
    const direct = await attempt(url, maxSizeKB, timeoutMs);
    if (direct) {
      return { ...direct, size: direct.html.length, viaProxy: false };
    }
    // Reachable but unusable (non-HTML, too large, error status) — don't retry.
    return null;
  } catch (error) {
    // Network-level failure. For cross-origin requests this is almost always
    // CORS, which the proxy can solve. Timeouts are not worth retrying.
    if (error instanceof DOMException && error.name === 'AbortError') {
      console.debug('[Crawler] Timeout:', url);
      return null;
    }
    if (!allowProxy) {
      console.debug('[Crawler] Blocked (CORS) and proxy disabled:', url);
      return null;
    }
  }

  // --- 2. Proxy fallback ---
  try {
    const proxied = await attempt(proxyUrl(url), maxSizeKB, timeoutMs);
    if (!proxied) return null;
    return { ...proxied, size: proxied.html.length, viaProxy: true };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      console.debug('[Crawler] Proxy timeout:', url);
    } else {
      console.debug('[Crawler] Proxy failed:', url);
    }
    return null;
  }
}
