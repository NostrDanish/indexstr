/**
 * SSRF guard — never fetch private/loopback/link-local targets, and never
 * ask the CORS proxy to fetch them either.
 *
 * A browser crawler mostly relies on the browser's own network sandbox, but
 * Indexstr routes fetches through a third-party CORS proxy — and the proxy
 * CAN reach internal infrastructure. This module is the client-side belt:
 * no request (direct or proxied) is ever issued for a non-public host.
 *
 * WHATWG URL parsing normalizes some weird IPv4 representations for us
 * (`0x7f000001`, `2130706433`, `0177.0.0.1` all parse to 127.0.0.1), but
 * isPrivateHost is also called with raw hostnames, so the IPv4 parser below
 * accepts every form a URL parser might (dotted quad, short forms, and
 * decimal/hex/octal integers).
 *
 * IPv4-embedded IPv6 forms are unfolded and re-checked as IPv4:
 *   ::ffff:a.b.c.d / ::ffff:xxxx:xxxx   IPv4-mapped (::ffff:0:0/96)
 *   ::a.b.c.d                           IPv4-compatible (::/96, deprecated)
 *   64:ff9b::a.b.c.d                    NAT64 (64:ff9b::/96, RFC 6052)
 *   2002:xxxx:xxxx::                    6to4 (2002::/16, RFC 3056)
 *   2001:0000::…                        Teredo (2001::/32, client v4 XORed)
 *
 * KNOWN LIMITATIONS (documented, not fixable at this layer):
 *   - Hostname-only: a public DNS name that resolves to 10/8 (rebinding)
 *     passes; the proxy resolves server-side. Mitigation belongs in the
 *     proxy or a resolver-aware layer.
 *   - On the PROXIED path, redirects are followed by the proxy server-side
 *     and cannot be re-validated here; only direct-path redirect targets
 *     are re-checked (fetcher.ts).
 */

/** True when a hostname is private/loopback/link-local/reserved. */
export function isPrivateHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (!host) return true;

  // Strip IPv6 brackets.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  // Names that never resolve publicly.
  if (host === 'localhost' || host === 'localhost.') return true;
  if (
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.intranet') ||
    host.endsWith('.lan') ||
    host.endsWith('.home') ||
    host === 'metadata.google.internal'
  ) {
    return true;
  }

  // IPv6 literal (after bracket-strip, a ':' means IPv6 — DNS names can't
  // contain one, so anything unparseable fails closed).
  if (host.includes(':')) return isPrivateIPv6(host);

  // IPv4 literal in any form (dotted quad, short forms, integer/hex/octal).
  const v4 = parseIPv4(host);
  if (v4 !== null) return isPrivateIPv4Addr(v4);

  return false;
}

/** True when a full URL targets a private host (fail closed on parse errors). */
export function isPrivateUrl(url: string): boolean {
  try {
    return isPrivateHost(new URL(url).hostname);
  } catch {
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* IPv4                                                                */
/* ------------------------------------------------------------------ */

/**
 * Parse an IPv4 literal in any form a URL parser might accept:
 *   127.0.0.1        dotted quad
 *   127.1            short form (last part widens to fill)
 *   2130706433       single 32-bit integer
 *   0x7f000001       hex
 *   017700000001     octal (leading 0)
 * Returns the 32-bit address as an unsigned number, or null if not IPv4.
 */
function parseIPv4(host: string): number | null {
  if (!host.includes('.')) {
    const n = parseIntAuto(host);
    if (n === null || n > 0xffffffff) return null;
    return n;
  }

  const parts = host.split('.');
  if (parts.length < 2 || parts.length > 4) return null;

  const nums: number[] = [];
  for (const part of parts) {
    const n = parseIntAuto(part);
    if (n === null) return null;
    nums.push(n);
  }

  // All but the last part are single bytes; the last part widens to fill
  // the remaining bytes (127.1 → 127.0.0.1).
  let addr = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    if (nums[i] > 0xff) return null;
    addr += nums[i] * 2 ** (8 * (3 - i));
  }
  const lastBits = 8 * (5 - parts.length);
  const last = nums[parts.length - 1];
  if (last >= 2 ** lastBits) return null;
  addr += last;
  return addr >>> 0;
}

function parseIntAuto(s: string): number | null {
  if (s === '') return null;
  if (/^0[xX][0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
  if (/^0[0-7]+$/.test(s)) return parseInt(s, 8); // legacy octal (leading 0)
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  return null;
}

/** Range check on a 32-bit IPv4 address. */
function isPrivateIPv4Addr(ip: number): boolean {
  const a = ip >>> 24;
  const b = (ip >>> 16) & 0xff;
  const c = (ip >>> 8) & 0xff;
  return (
    a === 0 ||                              // 0.0.0.0/8       "this network"
    a === 10 ||                             // 10.0.0.0/8      RFC 1918
    (a === 100 && b >= 64 && b <= 127) ||   // 100.64.0.0/10   CGNAT shared space
    a === 127 ||                            // 127.0.0.0/8     loopback
    (a === 169 && b === 254) ||             // 169.254.0.0/16  link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) ||    // 172.16.0.0/12   RFC 1918
    (a === 192 && b === 0 && c === 0) ||    // 192.0.0.0/24    IETF protocol assignments
    (a === 192 && b === 0 && c === 2) ||    // 192.0.2.0/24    TEST-NET-1 (documentation)
    (a === 192 && b === 168) ||             // 192.168.0.0/16  RFC 1918
    (a === 198 && (b === 18 || b === 19)) ||// 198.18.0.0/15   benchmarking
    (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 TEST-NET-2 (documentation)
    (a === 203 && b === 0 && c === 113) ||  // 203.0.113.0/24  TEST-NET-3 (documentation)
    (a >= 224 && a <= 239) ||               // 224.0.0.0/4     multicast
    a >= 240                                // 240.0.0.0/4     reserved (incl. broadcast)
  );
}

/* ------------------------------------------------------------------ */
/* IPv6                                                                */
/* ------------------------------------------------------------------ */

/**
 * Parse an IPv6 literal into eight 16-bit words, or null if unparseable.
 * Handles `::` compression and a trailing embedded dotted-quad
 * (`::ffff:127.0.0.1` counts as the last two words). A zone id
 * (`fe80::1%eth0`) is stripped — browsers won't hand us one, but the guard
 * must not be confused by it.
 */
function parseIPv6(input: string): number[] | null {
  let h = input;
  const zone = h.indexOf('%');
  if (zone !== -1) h = h.slice(0, zone);

  // Embedded trailing dotted-quad IPv4 = the last two 16-bit words.
  const tailWords: number[] = [];
  const dot = h.lastIndexOf('.');
  if (dot !== -1) {
    const colon = h.lastIndexOf(':');
    if (colon === -1 || colon > dot) return null; // bare v4 — not IPv6
    const v4 = parseIPv4(h.slice(colon + 1));
    if (v4 === null) return null;
    tailWords.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
    // Remove ':a.b.c.d'; if the colon we ate was part of '::', restore it.
    h = h.slice(0, colon);
    if (h.endsWith(':') && !h.endsWith('::')) h += ':';
  }

  const parseSide = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const halves = h.split('::');
  if (halves.length > 2) return null;

  if (halves.length === 2) {
    const left = parseSide(halves[0]);
    const right = parseSide(halves[1]);
    if (left === null || right === null) return null;
    const fill = 8 - (left.length + right.length + tailWords.length);
    if (fill < 1) return null; // '::' must compress at least one word
    return [...left, ...Array<number>(fill).fill(0), ...right, ...tailWords];
  }

  const full = parseSide(h);
  if (full === null) return null;
  const words = [...full, ...tailWords];
  return words.length === 8 ? words : null;
}

/** Unsigned 32-bit v4 address from two 16-bit words. */
function v4FromWords(hi: number, lo: number): number {
  return ((hi << 16) | lo) >>> 0;
}

function isPrivateIPv6(host: string): boolean {
  const words = parseIPv6(host);
  if (words === null) return true; // ':' present but unparseable — fail closed
  const [w0, w1, w2, w3, w4, w5, w6, w7] = words;

  // :: (unspecified) and ::1 (loopback).
  if (words.every((w) => w === 0)) return true;
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0 && w7 === 1) return true;

  if ((w0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((w0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((w0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if (w0 === 0x0100 && w1 === 0 && w2 === 0 && w3 === 0) return true; // 100::/64 discard-only

  // IPv4-embedded transition forms — unfold and re-check as IPv4.
  // ::/96 IPv4-compatible (e.g. ::127.0.0.1) — :: and ::1 handled above.
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    return isPrivateIPv4Addr(v4FromWords(w6, w7));
  }
  // ::ffff:0:0/96 IPv4-mapped (e.g. ::ffff:127.0.0.1, ::ffff:7f00:1).
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
    return isPrivateIPv4Addr(v4FromWords(w6, w7));
  }
  // NAT64 64:ff9b::/96 (RFC 6052) — embedded v4 in the last 32 bits.
  if (w0 === 0x0064 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    return isPrivateIPv4Addr(v4FromWords(w6, w7));
  }
  // 6to4 2002::/16 (RFC 3056) — embedded v4 in words 1–2.
  if (w0 === 0x2002) {
    return isPrivateIPv4Addr(v4FromWords(w1, w2));
  }
  // Teredo 2001:0000::/32 (RFC 4380) — client v4 = last 32 bits XOR 0xffffffff.
  if (w0 === 0x2001 && w1 === 0) {
    return isPrivateIPv4Addr(v4FromWords(w6 ^ 0xffff, w7 ^ 0xffff));
  }

  return false; // other global v6 is fine
}
