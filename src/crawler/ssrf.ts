/**
 * SSRF guard — never fetch private/loopback/link-local targets, and never
 * ask the CORS proxy to fetch them either.
 *
 * A browser crawler mostly relies on the browser's own network sandbox, but
 * Indexstr routes fetches through a third-party CORS proxy — and the proxy
 * CAN reach internal infrastructure. This module is the client-side belt:
 * no request (direct or proxied) is ever issued for a non-public host.
 *
 * WHATWG URL parsing normalizes the weird IPv4 representations for us
 * (`0x7f000001`, `2130706433`, `0177.0.0.1` all parse to 127.0.0.1), so
 * checking the parsed hostname covers those bypasses. IPv4-mapped IPv6
 * (`::ffff:127.0.0.1`) is unfolded and checked as IPv4.
 */

/** True when a hostname is private/loopback/link-local/reserved. */
export function isPrivateHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (!host) return true;

  // Strip IPv6 brackets.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  // Names that never resolve publicly.
  if (host === 'localhost' || host === 'localhost.') return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;

  // IPv4-mapped IPv6 (::ffff:7f00:1 or ::ffff:127.0.0.1) → check the v4 part.
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+|[0-9a-f:]+)$/i);
  if (mapped) {
    const v4 = mapped[1];
    if (v4.includes('.')) return isPrivateIPv4(v4);
    // Hex form: last two 16-bit groups are the address.
    const groups = v4.split(':').filter((g) => g.length > 0);
    if (groups.length >= 2) {
      const hi = parseInt(groups[groups.length - 2], 16);
      const lo = parseInt(groups[groups.length - 1], 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        return isPrivateIPv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
      }
    }
    return true; // Unparseable mapped form — fail closed.
  }

  // Plain IPv6.
  if (host.includes(':')) {
    if (host === '::1' || host === '::' || host === '0:0:0:0:0:0:0:1') return true;
    const first = host.split(':')[0];
    const firstWord = parseInt(first || '0', 16);
    if (!Number.isFinite(firstWord)) return true;
    if ((firstWord & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((firstWord & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    return false; // other global v6 is fine
  }

  // Plain IPv4 (already normalized by the URL parser).
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIPv4(host);

  return false;
}

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT shared address space
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
