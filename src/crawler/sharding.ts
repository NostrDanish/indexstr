/**
 * Deterministic crawl-space sharding — the coordination-free mechanism that
 * turns many Indexstr installs into one distributed indexing network.
 *
 * THE IDEA
 * --------
 * Every normalized URL maps to exactly one of 256 shards (0x00–0xff).
 * Every node has a *home shard* derived from its indexer pubkey. A node
 * prefers work from its home shard, so a hundred nodes loading the same
 * collection naturally split it instead of all crawling the same URLs.
 *
 * No coordinator, no registration, no consensus: two nodes with the same
 * seed set compute the same assignment locally, and nodes that disappear
 * simply stop taking work — nothing needs to be rebalanced.
 *
 * THE HASH
 * --------
 * Sharding uses FNV-1a 32-bit over the SIP-01-normalized URL, not SHA-256.
 * Rationale: it must be computable synchronously in bulk (seeding 50k URLs
 * at once rules out crypto.subtle), and it only needs uniform distribution
 * — it carries no identity or integrity role (that stays with the SIP-01
 * `d` tag). FNV-1a is specified in a comment below so independent
 * implementations (CLI nodes, relays) can reproduce it in any language:
 *
 *   hash := 2166136261
 *   for each byte b of the UTF-8 encoding of the normalized URL:
 *     hash := hash XOR b
 *     hash := (hash * 16777619) mod 2^32
 *   shard := hash >> 24          // top byte → 256 shards
 *
 * The node home shard is the first byte of the indexer pubkey:
 *   home := parseInt(pubkey_hex[0:2], 16)
 *
 * SCHEDULING
 * ----------
 * Work selection is *preferential*, not exclusive: a node takes home-shard
 * jobs first, but still samples other shards (default 1 in 4 picks). With
 * few nodes online that keeps the whole space covered; with many nodes,
 * cross-shard traffic becomes cheap redundancy (independent observations —
 * the SIP-01 confidence signal) instead of the dominant cost.
 */

export const SHARD_COUNT = 256;

/**
 * Probability that the scheduler picks outside the home shard when home
 * work is available. 0.25 ≈ up to ~4 independent observations per URL once
 * the network is dense, without starving coverage when it is sparse.
 */
export const CROSS_SHARD_SAMPLING = 0.25;

/** FNV-1a 32-bit. Uniform enough for sharding; NOT a cryptographic hash. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);
    // Encode non-BMP code points as their UTF-16 surrogate pair values;
    // all realistic URL characters are BMP after normalization anyway.
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193);
    // Fold in the high byte for code points above 0xFF.
    if (code > 0xff) {
      hash = Math.imul(hash ^ (code >>> 8), 0x01000193);
    }
  }
  return hash >>> 0;
}

/** Map a SIP-01-normalized URL to its shard (0–255). */
export function urlShard(normalizedUrl: string): number {
  return fnv1a32(normalizedUrl) >>> 24;
}

/** A node's home shard: first byte of its indexer pubkey (hex). */
export function nodeShard(pubkeyHex: string): number {
  const byte = parseInt(pubkeyHex.slice(0, 2), 16);
  return Number.isFinite(byte) ? byte : 0;
}

/** Human label for a shard, e.g. 167 → "A7". */
export function shardLabel(shard: number): string {
  return shard.toString(16).toUpperCase().padStart(2, '0');
}
