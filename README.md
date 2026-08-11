# Indexstr

<p align="center">
  <img src="public/brand/logo.png" alt="Indexstr — a spider sitting in its web" width="192" height="192">
</p>

**The web, pre-indexed on Nostr.** Indexstr is a decentralized browser-based web indexer — a fork of [Crawlstr](https://github.com/NostrDanish/Crwalstr) that ships with **curated URL collections built in**, so there is something worth indexing from the very first click. No backend. No tracking. No accounts required.

Load a collection, press **Start Crawling**, and every page becomes a **kind 39697 web index observation** on the shared [SIP-01](https://github.com/NostrDanish/SIP-01) index — instantly searchable by [0xSearchstr](https://0xsearchstr.shakespeare.wtf), [0xPresearchstr](https://presearchstr.shakespeare.wtf), [UNCAGED](https://uncaged.shakespeare.wtf), and any future SIP-01 compatible client.

---

## The Collections

Eight curated link packs ship inside the app as SQLite databases, parsed locally in your browser (see `src/crawler/sqlite.ts` — a tiny read-only SQLite reader written for this purpose):

| Collection | Contents | Size |
|------------|----------|------|
| **Top Sites** | High-traffic websites, news aggregators, community threads | ~26 MB |
| **Awesome Lists** | Curated awesome-* lists — the best tools and resources per topic | ~20 MB |
| **RSS Feeds** | RSS and Atom feeds across tech, science, news and culture | ~19 MB |
| **Music** | Artists, labels, streaming pages, music communities | ~10 MB |
| **Books** | Digital libraries, book search engines, reading platforms | ~1.3 MB |
| **Movies** | Film databases, streaming indexes, cinema resources | ~1.2 MB |
| **Memes** | Meme archives, humor sites, internet culture | ~1 MB |
| **Video Games** | Game databases, stores, mods, gaming communities | ~0.9 MB |

Databases download on demand (only the collection you load), parse in a couple of seconds, and the extracted URL list is cached in IndexedDB — reloading a collection later is instant. Collection URLs are indexed **exactly as listed** (`followLinks: false`): the collection IS the crawl plan.

---

## How It Works

```
You load a curated collection (or seed URLs manually)
       │
       ▼
┌─────────────┐
│   Crawler   │  IndexedDB queue, persistent across sessions
│   Engine    │  Battery/WiFi/bandwidth aware
└──────┬──────┘
       │
       ▼
   Fetch page (respects robots.txt, rate-limited per domain)
       │
       ▼
   Parse HTML (title, description, text, links, language)
       │
       ▼
   SHA-256 content hash (dedup across the network)
       │
       ▼
   Sign kind 39697 event with per-device indexer key
       │
       ▼
   Publish to Nostr relays (SIP-01)
       │
       ▼
┌──────────────────────────────────────┐
│        Shared SIP-01 Index           │
│                                      │
│  0xSearchstr reads it                │
│  0xPresearchstr reads it             │
│  UNCAGED reads it                    │
│  Your fork reads it                  │
│  Any SIP-01 client reads it          │
└──────────────────────────────────────┘
```

---

## What Makes This Different

Crawlstr made every browser a potential crawler. Indexstr answers the next question: *"crawl what, exactly?"* — with thousands of curated URLs loaded and ready.

| Feature | Description |
|---------|-------------|
| **Bundled collections** | 8 curated URL packs, from top sites to memes |
| **In-browser SQLite** | Collection databases parsed client-side by a purpose-built reader |
| **Opt-in only** | Nothing runs without explicitly pressing "Start Crawling" |
| **SIP-01 native** | Same protocol as 0xSearchstr, 0xPresearchstr, UNCAGED — one shared index |
| **Per-device identity** | Anonymous indexer keypair, separate from your Nostr identity |
| **No query leakage** | Events contain page metadata only — never what anyone searched for |
| **Resource aware** | Battery, WiFi, bandwidth limits. Eco mode. Charging-only mode. |
| **robots.txt** | Respected by default (configurable) |
| **Rate limited** | Seconds between requests per domain — slow, respectful, unstoppable |
| **Persistent queue** | IndexedDB-backed, survives browser restarts |
| **PWA** | Installable, works on mobile and desktop |

---

## Quick Start

```bash
git clone <this-repo>
cd indexstr
npm install
npm run dev
```

Open the printed URL, open the **Collections** tab, load a pack, press **Start Crawling**.

---

## Usage

### Load a Collection

The **Collections** tab shows the eight bundled packs with URL counts and samples. **Load into queue** downloads the database, extracts every URL (normalized per SIP-01 §7, deduped, already-crawled pages skipped), and enqueues them at depth 0 — each URL is indexed as-is, no link following.

Large collections take days to work through at a respectful per-domain pace. That is by design: the queue persists across restarts and churns steadily whenever the crawler is on.

### Seed a URL manually

The **Seed URLs** tab still works exactly like Crawlstr: enter any URL and the crawler follows links up to depth 3.

```
https://bitcoin.org
```

### Crawler Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **WiFi Only** | Off | Only crawl on WiFi networks |
| **Charging Only** | Off | Only crawl while device is charging |
| **Respect robots.txt** | On | Follow website crawling policies |
| **Eco Mode** | On | Slower crawling, less resource usage |

### Indexer Identity

Each browser gets its own anonymous indexer keypair (visible in the dashboard). This key signs all kind 39697 observations. It is:

- **Pseudonymous** — not linked to your personal Nostr identity
- **Replaceable** — regenerating creates a new indexer
- **Local** — the secret key never leaves your browser
- **Exportable** — for backup or migration

---

## Protocol

Indexstr publishes **SIP-01 (Search Index Protocol)** events — the same protocol used by the entire Searchstr ecosystem.

### Kind 39697 — Web Index Observation

```json
{
  "kind": 39697,
  "pubkey": "<device indexer pubkey>",
  "created_at": 1786250000,
  "content": "{\"title\":\"Example Page\",\"description\":\"A page about...\"}",
  "tags": [
    ["d", "widx:9f86d081884c7d659a2feaa0c55ad015"],
    ["u", "https://example.com/page"],
    ["l", "en"],
    ["x", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["v", "1"],
    ["source", "indexstr/1"],
    ["network", "clearnet"],
    ["type", "page"],
    ["alt", "Web index observation: Example Page"]
  ]
}
```

| Tag | Meaning |
|-----|---------|
| `d` | `"widx:" + sha256(normalized_url)[0:32]` — URL identity, identical across all indexers |
| `u` | Canonical URL (normalized per SIP-01 §7) |
| `x` | Content hash: `sha256(title + "\n" + description)` |
| `v` | Schema version `"1"` |
| `l` | ISO 639-1 language code |
| `source` | `"indexstr/1"` |
| `network` | Extension registry (§9.2) — always `clearnet` for a browser crawler |
| `type` | Extension registry — `repository` for GitHub/GitLab, else `page` |
| `alt` | Human-readable description (the `alt` convention, spec §12.3) |

Full schema documentation: [NIP.md](NIP.md) · Canonical spec: [SIP-01 v1.1](https://github.com/NostrDanish/SIP-01/blob/main/public/spec/SIP-01.md)

### Relay Pool

Observations are published to:

- `wss://relay-na1.metanomalist.com/`
- `wss://relay.ditto.pub/` (NIP-50 search)
- `wss://jskitty.cat/nostr`
- `wss://search.nos.today/` (NIP-50 search)
- `wss://relay.primal.net/`
- `wss://nostr.hifish.org/`
- `wss://relay.nostr.band/` (NIP-50 search)
- `wss://relay.noswhere.com/` (NIP-50 search)
- `wss://relay.damus.io/`
- `ws://acuy3mjnv26tkyaaucndlxmg2ocntz4rtebhavk57vgruozm42iaznqd.onion/` (Tor only — reachable from Tor Browser; clearnet browsers skip it)

Each observation is pushed to every relay in the set via targeted per-relay connections.

---

## Federation: One Index, Many Crawlers

Indexstr is **one more independent indexer** in the SIP-01 ecosystem:

```
Indexstr (browser indexer w/ curated collections)
    │
    ▼ kind 39697, signed by device indexer key
Nostr Relays
    │
    ├──→ 0xSearchstr (search engine) reads it
    ├──→ 0xPresearchstr (search engine) reads it
    ├──→ UNCAGED (search engine template) reads it
    └──→ Any SIP-01 client reads it
```

Multiple crawlers observing the same URL produce events with the **same `d` tag** and different pubkeys — search nodes group by `d` and count distinct authors ("7 independent indexers saw this page").

---

## Browser Limitations

Indexstr is honest about what a browser can and cannot do:

- **CORS** — A browser cannot read cross-origin responses unless the site sends CORS headers, and most don't. Indexstr tries a direct fetch first, then falls back to a **CORS proxy** so real websites can actually be crawled. The trade-off is honest: when the proxy is used, the proxy operator sees which URL was fetched (never a search query, never a user identity). The dashboard shows the direct/proxy split per session.
- **JavaScript rendering** — Indexstr parses static HTML. Single-page apps that require JavaScript rendering won't have their full content extracted.
- **Background execution** — Mobile browsers may throttle or kill background tabs. The crawler is most effective when the tab is active.
- **Rate limits** — Per-domain rate limiting is built-in. This is respectful by design, and why bundled collections are curated rather than endless.

For unrestricted crawling, run a desktop/CLI SIP-01 crawler alongside Indexstr.

---

## Tech Stack

- **React 19** + TypeScript + Vite
- **TailwindCSS 4** + shadcn/ui
- **Nostrify** — Nostr relay pool
- **nostr-tools** — Event signing (`finalizeEvent`)
- **idb** — IndexedDB wrapper for the crawl queue + collection cache
- **Custom SQLite reader** (`src/crawler/sqlite.ts`) — parses collection databases in-browser, no WASM
- **TanStack Query** — Data fetching + caching
- **PWA** — Service worker, manifest, installable

---

## Project Structure

```
src/
├── crawler/
│   ├── engine.ts           ← Main crawler orchestrator (crawl loop, queue, scheduling)
│   ├── queue.ts            ← IndexedDB persistent queue (survives restarts)
│   ├── collections.ts      ← Curated collection registry + loader/cache
│   ├── sqlite.ts           ← Minimal read-only SQLite parser (b-tree, records, overflow)
│   ├── fetcher.ts          ← HTTP fetcher (CORS, timeout, size limits)
│   ├── parser.ts           ← HTML parser (title, description, text, links, language)
│   ├── hasher.ts           ← SHA-256 content hashing for local dedup
│   ├── webIndex.ts         ← SIP-01: URL normalization, event build/parse (byte-compatible)
│   ├── indexerIdentity.ts  ← Per-device anonymous indexer keypair
│   ├── publisher.ts        ← Signs + publishes kind 39697 via finalizeEvent
│   ├── relays.ts           ← Ecosystem relay pool configuration
│   ├── robots.ts           ← robots.txt parser with caching
│   ├── limits.ts           ← Per-domain rate limiting
│   └── types.ts            ← TypeScript interfaces
├── components/
│   └── crawler/
│       ├── CrawlerDashboard.tsx   ← Main UI (toggle, stats, tabs)
│       ├── CollectionsPanel.tsx   ← Bundled collection cards + load/progress
│       └── IndexstrLogo.tsx       ← Brand mark
├── hooks/
│   └── useCrawler.ts       ← React hook wiring engine to Nostr
├── pages/
│   └── Index.tsx           ← Landing page + dashboard
└── NIP.md                  ← Protocol documentation

public/
└── collections/            ← Bundled SQLite URL collections (loaded on demand)
```

---

## Ecosystem

| Project | Role | URL |
|---------|------|-----|
| **Indexstr** (this) | Browser indexer w/ collections → SIP-01 publisher | — |
| [Crawlstr](https://github.com/NostrDanish/Crwalstr) | The original browser crawler | [crawlstr.shakespeare.wtf](https://crawlstr.shakespeare.wtf) |
| [0xSearchstr](https://github.com/NostrDanish/0xSearchstr) | Search engine → SIP-01 reader | [0xsearchstr.shakespeare.wtf](https://0xsearchstr.shakespeare.wtf) |
| [0xPresearchstr](https://github.com/NostrDanish/0xPresearchstr) | Community fork with keyword staking | [presearchstr.shakespeare.wtf](https://presearchstr.shakespeare.wtf) |
| [UNCAGED-ENGINE](https://github.com/NostrDanish/UNCAGED-ENGINE) | Minimal search engine template | [uncaged.shakespeare.wtf](https://uncaged.shakespeare.wtf) |

---

## Privacy, Honestly

- **No login required** to index. No account. No tracking.
- Observations are signed by a **per-device anonymous keypair**, never your personal Nostr identity.
- Events contain **page metadata only** — never search queries, never browsing history.
- Your crawl history and the collection cache stay in your browser (IndexedDB). Clearing browser data removes them.
- Relay operators see the observation event and your IP address — that's how Nostr works. Key separation is guaranteed; network anonymity is not.
- Use a VPN or Tor — we recommend [NymVPN](https://nym.com).

**Support us:** [https://nym.com/pricing?ref=aYPKAFmGpJi](https://nym.com/pricing?ref=aYPKAFmGpJi)

---

## License

MIT

---

*Vibed with [Shakespeare](https://shakespeare.diy)*
