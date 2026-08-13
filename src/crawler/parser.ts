// HTML parser — extracts content from crawled pages

import type { ParsedPage } from './types';

export function parsePage(html: string, baseUrl: string): ParsedPage {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Extract title
  const title = doc.querySelector('title')?.textContent?.trim() ??
    doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() ??
    '';

  // Extract description
  const description =
    doc.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ??
    doc.querySelector('meta[property="og:description"]')?.getAttribute('content')?.trim() ??
    '';

  // Representative image (SIP-01 §6: https-only, enforced at build time too).
  // og:image content is frequently relative — resolve against the page URL.
  const imageRaw =
    doc.querySelector('meta[property="og:image"]')?.getAttribute('content')?.trim() ??
    doc.querySelector('meta[name="twitter:image"]')?.getAttribute('content')?.trim() ??
    '';
  let image = '';
  if (imageRaw) {
    try {
      image = new URL(imageRaw, baseUrl).href;
    } catch {
      image = '';
    }
  }

  // Claimed publication time (SIP-01 §6: `published` tag, unix seconds)
  const publishedRaw =
    doc.querySelector('meta[property="article:published_time"]')?.getAttribute('content')?.trim() ??
    doc.querySelector('meta[name="date"]')?.getAttribute('content')?.trim() ??
    doc.querySelector('time[datetime]')?.getAttribute('datetime')?.trim() ??
    '';
  const publishedTs = publishedRaw ? Math.floor(new Date(publishedRaw).getTime() / 1000) : NaN;
  const published = Number.isFinite(publishedTs) ? publishedTs : undefined;

  // --- Classification evidence (enrichment layer; all source-supplied) ---

  // meta keywords: the site's own topic claims.
  const keywordsRaw =
    doc.querySelector('meta[name="keywords"]')?.getAttribute('content') ?? '';
  const keywords = keywordsRaw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 1 && k.length < 60)
    .slice(0, 20);

  // og:type (article / website / video.* / product / …)
  const ogType = doc
    .querySelector('meta[property="og:type"]')
    ?.getAttribute('content')
    ?.trim()
    .toLowerCase() || undefined;

  // JSON-LD @type values (Article, BlogPosting, VideoObject, Product, …)
  const jsonLdTypes: string[] = [];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
    try {
      const data: unknown = JSON.parse(el.textContent ?? '');
      const collect = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach(collect);
          return;
        }
        const rec = node as Record<string, unknown>;
        const t = rec['@type'];
        if (typeof t === 'string') jsonLdTypes.push(t);
        else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && jsonLdTypes.push(x));
        if (rec['@graph']) collect(rec['@graph']);
      };
      collect(data);
    } catch {
      // Malformed JSON-LD — ignore.
    }
  });

  // First headings — strong topical evidence.
  const headings: string[] = [];
  doc.querySelectorAll('h1, h2').forEach((el) => {
    if (headings.length >= 4) return;
    const t = el.textContent?.replace(/\s+/g, ' ').trim();
    if (t && t.length > 3 && t.length < 200) headings.push(t);
  });

  // Remove non-content elements
  const removeSelectors = 'script, style, noscript, iframe, nav, footer, header, aside, [role="navigation"], [role="banner"], [role="contentinfo"], .nav, .navbar, .sidebar, .footer, .header, .menu, .ad, .ads, .advertisement, .social-share, .comments';
  doc.querySelectorAll(removeSelectors).forEach(el => el.remove());

  // Extract main content
  const mainContent =
    doc.querySelector('main') ??
    doc.querySelector('article') ??
    doc.querySelector('[role="main"]') ??
    doc.querySelector('.content') ??
    doc.querySelector('#content') ??
    doc.body;

  const text = mainContent?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  // Detect language
  const language = doc.documentElement.lang?.split('-')[0] ?? 'en';

  // Extract links
  const linkElements = doc.querySelectorAll('a[href]');
  const links: string[] = [];

  linkElements.forEach(el => {
    const href = el.getAttribute('href');
    if (!href) return;

    try {
      const absoluteUrl = new URL(href, baseUrl).href;
      // Only include http(s) links, no fragments, no mailto/tel
      if (absoluteUrl.startsWith('http') && !absoluteUrl.includes('#')) {
        links.push(absoluteUrl);
      }
    } catch {
      // Invalid URL, skip
    }
  });

  return {
    title,
    description,
    image,
    published,
    text: text.slice(0, 10000), // Cap text at 10k chars for storage
    language,
    links: [...new Set(links)], // Deduplicate
    wordCount,
    keywords,
    ogType,
    jsonLdTypes: [...new Set(jsonLdTypes)],
    headings,
  };
}
