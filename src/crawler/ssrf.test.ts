import { describe, expect, test } from 'vitest';
import { isPrivateHost, isPrivateUrl } from './ssrf';

/**
 * SSRF guard — these must NEVER be fetched, directly or via the proxy.
 * The proxy's network can reach infrastructure the browser's cannot.
 */
describe('isPrivateHost', () => {
  test('loopback in every form', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('foo.localhost')).toBe(true);
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('127.1.2.3')).toBe(true);
    // WHATWG URL normalization collapses weird IPv4 reps before we see them:
    expect(isPrivateUrl('http://0x7f000001/')).toBe(true); // hex 127.0.0.1
    expect(isPrivateUrl('http://2130706433/')).toBe(true); // decimal 127.0.0.1
  });

  test('RFC-1918 and link-local (incl. cloud metadata)', () => {
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('10.255.255.255')).toBe(true);
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
    expect(isPrivateHost('192.168.1.1')).toBe(true);
    expect(isPrivateHost('169.254.169.254')).toBe(true); // cloud metadata
    expect(isPrivateHost('169.254.0.1')).toBe(true);
    expect(isPrivateHost('0.0.0.0')).toBe(true);
  });

  test('CGNAT shared address space', () => {
    expect(isPrivateHost('100.64.0.1')).toBe(true);
    expect(isPrivateHost('100.127.255.254')).toBe(true);
    expect(isPrivateHost('100.63.255.255')).toBe(false); // just outside
  });

  test('IPv6 loopback, ULA, link-local, mapped-v4', () => {
    expect(isPrivateHost('::1')).toBe(true);
    expect(isPrivateHost('[::1]')).toBe(true);
    expect(isPrivateHost('fc00::1')).toBe(true);
    expect(isPrivateHost('fd12:3456::1')).toBe(true);
    expect(isPrivateHost('fe80::1')).toBe(true);
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateHost('::ffff:7f00:1')).toBe(true);
    expect(isPrivateHost('::ffff:10.0.0.5')).toBe(true);
    expect(isPrivateHost('::ffff:192.168.0.1')).toBe(true);
  });

  test('non-public TLD-ish names fail closed', () => {
    expect(isPrivateHost('printer.local')).toBe(true);
    expect(isPrivateHost('nas.internal')).toBe(true);
    expect(isPrivateHost('')).toBe(true);
  });

  test('public hosts pass', () => {
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('172.15.0.1')).toBe(false); // just outside 172.16/12
    expect(isPrivateHost('11.0.0.1')).toBe(false);
    expect(isPrivateHost('2606:4700:4700::1111')).toBe(false);
  });

  test('isPrivateUrl fails closed on garbage', () => {
    expect(isPrivateUrl('not a url at all')).toBe(true);
    expect(isPrivateUrl('https://example.com/public/page')).toBe(false);
    expect(isPrivateUrl('http://192.168.0.200/admin')).toBe(true);
  });
});
