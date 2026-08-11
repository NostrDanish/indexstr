import { describe, expect, test } from 'vitest';
import { normalizeIndexUrl, documentId, contentHash } from './webIndex';

/**
 * SIP-01 §7 normalization — the ecosystem-critical property: every
 * implementation must produce byte-identical output for the same page or
 * `d`-tag dedup breaks. Vectors mirror spec §13.1.
 */
describe('normalizeIndexUrl', () => {
  test('keeps a clean root URL unchanged', () => {
    expect(normalizeIndexUrl('https://example.com/')).toBe('https://example.com/');
  });

  test('spec vector: scheme/host case, default port, tracking, fragment, param order', () => {
    expect(
      normalizeIndexUrl('HTTPS://WWW.Example.Com:443/page/?b=2&utm_source=x&a=1#top'),
    ).toBe('https://example.com/page?a=1&b=2');
  });

  test('keeps a non-slash-terminated path as-is', () => {
    expect(normalizeIndexUrl('https://example.com/page')).toBe('https://example.com/page');
  });

  test('path case is significant (GitHub owner/repo must survive)', () => {
    expect(normalizeIndexUrl('https://github.com/NostrDanish/Crwalstr')).toBe(
      'https://github.com/NostrDanish/Crwalstr',
    );
  });

  test('strips known tracking parameters but keeps real ones', () => {
    expect(normalizeIndexUrl('https://example.com/?fbclid=abc&id=7')).toBe(
      'https://example.com/?id=7',
    );
  });

  test('removes default http port', () => {
    expect(normalizeIndexUrl('http://example.com:80/x')).toBe('http://example.com/x');
  });

  test('keeps non-default ports', () => {
    expect(normalizeIndexUrl('http://example.com:8080/x')).toBe('http://example.com:8080/x');
  });

  test('drops the fragment', () => {
    expect(normalizeIndexUrl('https://example.com/a#section')).toBe('https://example.com/a');
  });

  test('rejects non-http(s) schemes', () => {
    expect(normalizeIndexUrl('ftp://example.com/x')).toBeNull();
    expect(normalizeIndexUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeIndexUrl('javascript:alert(1)')).toBeNull();
  });

  test('rejects garbage', () => {
    expect(normalizeIndexUrl('not a url')).toBeNull();
    expect(normalizeIndexUrl('')).toBeNull();
  });

  test('trailing slash only stripped on non-root paths', () => {
    expect(normalizeIndexUrl('https://example.com/dir/')).toBe('https://example.com/dir');
    expect(normalizeIndexUrl('https://example.com/')).toBe('https://example.com/');
  });

  test('duplicate query parameters are preserved deterministically', () => {
    // Both ?a=1&a=2 values survive (they can be meaningful); order is stable.
    expect(normalizeIndexUrl('https://example.com/?a=2&a=1')).toBe(
      'https://example.com/?a=1&a=2',
    );
  });
});

describe('documentId', () => {
  test('is widx: + 32 hex chars, deterministic per URL', async () => {
    const a = await documentId('https://example.com/');
    const b = await documentId('https://example.com/');
    expect(a).toBe(b);
    expect(a).toMatch(/^widx:[0-9a-f]{32}$/);
  });

  test('different URLs get different ids', async () => {
    expect(await documentId('https://example.com/a')).not.toBe(
      await documentId('https://example.com/b'),
    );
  });
});

describe('contentHash', () => {
  test('sha256 of title + newline + description', async () => {
    const hash = await contentHash('Title', 'Desc');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await contentHash('Title', 'Desc')).toBe(hash);
    expect(await contentHash('Title', 'Other')).not.toBe(hash);
  });
});
