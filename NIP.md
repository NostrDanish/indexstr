# Indexstr — Event Kinds & Protocol Reference

Indexstr is a **browser-based web indexer** (a [Crawlstr](https://github.com/NostrDanish/Crwalstr) fork)
that ships with **curated URL collections** and publishes to the **shared SIP-01
(Search Index Protocol) index** on Nostr. It implements the **canonical SIP-01
specification v1.1** — [github.com/NostrDanish/SIP-01](https://github.com/NostrDanish/SIP-01)
(`public/spec/SIP-01.md`) — byte-compatibly with
[0xSearchstr](https://github.com/NostrDanish/0xSearchstr),
[0xPresearchstr](https://github.com/NostrDanish/0xPresearchstr),
[UNCAGED-ENGINE](https://github.com/NostrDanish/UNCAGED-ENGINE), and the
[UNCAGED Index Relay](https://github.com/NostrDanish/UNCAGED-Index-Relay).

## Protocol Compatibility

| Schema | Kind | Type | Status |
|--------|------|------|--------|
| Web Index Observation (SIP-01) | **39697** | addressable | **Written** by Indexstr |

Indexstr is a **pure SIP-01 publisher** — it only writes kind 39697 events.
It does NOT write community submissions (kind 30078) or query caches.

## What Indexstr Writes

### Kind 39697 — Web Index Observation (SIP-01)

One addressable event per `(crawler's indexer pubkey, normalized URL)` — a signed
statement: *"This device observed this web page at this time, and here is its
public metadata."*

```json
{
  "kind": 39697,
  "pubkey": "<device indexer pubkey, hex>",
  "created_at": 1786250000,
  "content": "{\"title\":\"Example Page\",\"description\":\"A page about...\",\"image\":\"https://example.com/og.jpg\"}",
  "tags": [
    ["d", "widx:9f86d081884c7d659a2feaa0c55ad015"],
    ["u", "https://example.com/page"],
    ["l", "en"],
    ["x", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["v", "1"],
    ["published", "1786200000"],
    ["source", "indexstr/1"],
    ["network", "clearnet"],
    ["type", "page"],
    ["alt", "Web index observation: Example Page"]
  ]
}
```

**Core tags (spec §5/§6):**

| Tag | Required | Meaning |
|-----|----------|---------|
| `d` | ✔ | `"widx:" + sha256(normalized_url)[0:32]` — URL identity, identical across all indexers |
| `u` | ✔ | Canonical URL (http/https only, ≤ 2048 chars, normalized per SIP-01 §7) |
| `v` | ✔ | Schema version `"1"` |
| `x` | ✔ | Content hash: `sha256(title + "\n" + description)` (§8) |
| `alt` | ✔ | Human-readable summary (the `alt` convention; spec §12.3) |
| `l` | – | ISO 639-1 language code (validated two-letter shape) |
| `t` | – | 0–8 lowercase topic tags matching `^[a-z0-9][a-z0-9-]{0,99}$` |
| `published` | – | Unix seconds — page's claimed publication time (§12.2) |
| `source` | – | `"indexstr/1"` — identifies this software (≤ 100 chars) |

**Extension tags (spec §9.2 registry):**

| Tag | Value | Meaning |
|-----|-------|---------|
| `network` | always `clearnet` | A browser crawler can only reach the clearnet |
| `type` | `page` / `repository` | `repository` for GitHub/GitLab hosts, else `page` |
| `platform` | e.g. `github`, `youtube`, `wikipedia` | Emitted for well-known hosts only |

**Key properties (same as all SIP-01 publishers):**

- **Per-device indexer identity** — each browser generates its own anonymous keypair
  on first use (`localStorage: sip:indexer:secret`). Never the user's personal key (§14).
- **No query leakage** — the event contains a URL and public page metadata, never
  what anyone searched for (§16).
- **URL normalization** — identical to SIP-01 §7: strips tracking params, lowercases
  scheme/host, removes `www.`, sorts query params, removes fragments. Verified
  byte-identical against the §13 test vectors.
- **Deduplication** — the `d` tag is deterministic from the normalized URL; the
  `x` tag is a content agreement signal. Multiple crawlers observing the same page
  produce events with the same `d` — search nodes count distinct authors.
- **Addressable** — re-crawling the same URL replaces the previous observation
  (one slot per indexer per URL).

## How Indexstr Differs from Other SIP-01 Publishers

| Feature | 0xSearchstr / UNCAGED | Indexstr |
|---------|----------------------|----------|
| **Trigger** | Search results surfaced by providers | Active web indexing |
| **Discovery** | Search results from external APIs | Bundled curated URL collections + manual seeds |
| **Depth** | 1 (direct results only) | 0 for collections (exact URLs), up to 3 for manual seeds |
| **Rate limiting** | N/A (API-driven) | Per-domain, configurable |
| **robots.txt** | N/A | Respected (configurable) |
| **Queue** | N/A | IndexedDB persistent queue |
| **Power management** | N/A | Battery/WiFi/bandwidth aware |

The **event schema is identical**. The difference is only in how URLs are discovered.

## Relay Publishing

Indexstr publishes to the same relay pool as the ecosystem:

**Search relays (NIP-50):**
- `wss://relay.nostr.band/`
- `wss://relay.ditto.pub/`
- `wss://search.nos.today/`
- `wss://relay.noswhere.com/`

**Write relays (for propagation):**
- `wss://relay.ditto.pub/`
- `wss://relay.primal.net/`
- `wss://relay.damus.io/`

## Reading the Index

Any SIP-01 compatible search engine can read Indexstr's observations:

```json
{
  "kinds": [39697],
  "#d": ["widx:9f86d081884c7d659a2feaa0c55ad015"]
}
```

Or browse by topic:

```json
{
  "kinds": [39697],
  "#t": ["nostr"],
  "limit": 50
}
```

Or query full-text via NIP-50 on SIP-01-aware relays, using the web-search
operators from spec §15 (`site:`, `title:`, `lang:`, `after:`, …):

```json
{
  "kinds": [39697],
  "search": "bitcoin privacy site:nostr.com lang:en after:2026-01-01",
  "limit": 20
}
```

## Trust Model

- Indexstr observations are **structurally trusted** — any indexer pubkey is accepted.
- Events are validated on parse: schema version, URL allowlist, field caps.
- Agreement across independent indexers (same `d`, different `pubkey`) is the
  ranking signal.
- Indexstr is just one more independent indexer in the SIP-01 ecosystem.

## References

- **Canonical spec (v1.1):** [NostrDanish/SIP-01](https://github.com/NostrDanish/SIP-01) — `public/spec/SIP-01.md`
- **Implementation guide:** [SIP-01/docs/IMPLEMENTATION-GUIDE.md](https://github.com/NostrDanish/SIP-01/blob/main/docs/IMPLEMENTATION-GUIDE.md)
- **Reference port:** [SIP-01/src/lib/sip01-utils.ts](https://github.com/NostrDanish/SIP-01/blob/main/src/lib/sip01-utils.ts)
- **0xSearchstr NIP.md:** [legacy schemas, community submissions, Nostra interop](https://github.com/NostrDanish/0xSearchstr/blob/main/NIP.md)
- **UNCAGED-ENGINE NIP.md:** [reference implementation schemas](https://github.com/NostrDanish/UNCAGED-ENGINE/blob/main/NIP.md)
- **UNCAGED Index Relay:** [validating relay profile](https://github.com/NostrDanish/UNCAGED-Index-Relay)
