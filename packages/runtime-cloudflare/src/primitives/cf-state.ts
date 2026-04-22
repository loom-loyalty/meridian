/**
 * Cloudflare implementation of the {@link StatePlugin} seam.
 *
 * Backed by the DO's SQLite-backed key/value storage. Adopter-visible
 * keys are prefixed with `state::` so internal keys (meta, inbox,
 * schedules...) live in disjoint namespaces without adopter
 * interference.
 *
 * Validates per RUNTIME-SPEC §4.2:
 *   • key:  UTF-8 bytes ≤ 1024          (throws MRD-CF-ST-001)
 *   • value: JSON-serialized ≤ 1 MB     (throws MRD-CF-ST-002)
 *   • key:  non-empty, no reserved prefix (throws MRD-CF-ST-003)
 *
 * Value size is approximated via `JSON.stringify` since the DO storage
 * API uses structured clone internally — exact byte counts aren't
 * reachable from user-space. JSON is a conservative upper bound for
 * anything that's also structured-clone-safe (no Dates/Maps/Sets/
 * BigInts), which covers the payload shapes the spec defines.
 */

import type { ListOptions, ListResult } from "@loom-loyalty/meridian-types";

import { meridianError } from "../errors.js";
import type { StatePlugin } from "./types.js";

const STATE_PREFIX = "state::";
const KEY_MAX_BYTES = 1024;
const VALUE_MAX_BYTES = 1_000_000; // 1 MB per spec

// Any key starting with `__` is reserved for internal metadata
// (`__meta__`, `__inbox__`, `__terminated__`, future additions). The
// plugin prevents adopters from writing into those namespaces.
const RESERVED_PREFIX = "__";

// Null byte appended to a cursor to produce the strict-greater
// successor key. DO storage.list(`{start}`) is INCLUSIVE, so passing
// `cursor` raw would duplicate the cursor key as the first entry of
// the next page. `${cursor}\0` sorts strictly after `${cursor}` and
// before any valid adopter-supplied successor (adopter keys are
// UTF-8 strings; no valid character sorts between `x` and `x\0`).
const NUL = String.fromCharCode(0);

export class CfStatePlugin implements StatePlugin {
  constructor(private readonly ctx: DurableObjectState) {}

  async save(key: string, value: unknown): Promise<void> {
    this.validateKey(key);
    this.validateValueSize(value, key);
    await this.ctx.storage.put(this.toStorageKey(key), value);
  }

  async load<T = unknown>(key: string): Promise<T | undefined> {
    this.validateKey(key);
    return this.ctx.storage.get<T>(this.toStorageKey(key));
  }

  async delete(key: string): Promise<void> {
    this.validateKey(key);
    await this.ctx.storage.delete(this.toStorageKey(key));
  }

  async list(opts: ListOptions = {}): Promise<ListResult> {
    // DO storage's list() returns a Map of keys → values. For the
    // primitive's ListResult shape we only return keys; callers that
    // want values go through load() per key. `prefix` is user-facing;
    // we translate to the full `state::<prefix>` form before calling
    // the underlying API. See NUL constant docstring for the cursor
    // strict-greater trick.
    const storagePrefix = STATE_PREFIX + (opts.prefix ?? "");
    const startKey = opts.cursor
      ? this.toStorageKey(opts.cursor) + NUL
      : undefined;
    const results = await this.ctx.storage.list({
      prefix: storagePrefix,
      limit: opts.limit,
      start: startKey,
    });

    const keys: string[] = [];
    for (const storageKey of results.keys()) {
      keys.push(storageKey.slice(STATE_PREFIX.length));
    }

    // Opaque cursor: DO's list() doesn't return one directly. If we
    // hit the requested limit, we expose the last key as the next
    // cursor so the caller can page. This is non-atomic (inserts
    // mid-scan can be missed), but matches ListOptions' semantics
    // which don't promise snapshot-isolated iteration.
    const cursor =
      opts.limit !== undefined && keys.length === opts.limit
        ? keys[keys.length - 1]
        : undefined;

    return { keys, cursor };
  }

  async update<T>(
    key: string,
    updater: (current: T | undefined) => T,
  ): Promise<T> {
    this.validateKey(key);
    // DO's blockConcurrencyWhile gives us atomic read-modify-write:
    // other requests to this DO serialize behind the callback until
    // it returns, so two concurrent updates can't interleave. This is
    // stronger than JS's event loop single-thread guarantee because
    // it extends across async boundaries within the callback.
    return this.ctx.blockConcurrencyWhile(async () => {
      const storageKey = this.toStorageKey(key);
      const current = await this.ctx.storage.get<T>(storageKey);
      const next = updater(current);
      this.validateValueSize(next, key);
      await this.ctx.storage.put(storageKey, next);
      return next;
    });
  }

  // ── internal ─────────────────────────────────────────────

  private toStorageKey(userKey: string): string {
    return `${STATE_PREFIX}${userKey}`;
  }

  private validateKey(key: string): void {
    if (!key) {
      throw meridianError("MRD-CF-ST-003", "state key is empty");
    }
    if (key.startsWith(RESERVED_PREFIX)) {
      throw meridianError(
        "MRD-CF-ST-003",
        `state key "${key}" uses reserved prefix "__"`,
        { context: { key } },
      );
    }
    if (key.startsWith(STATE_PREFIX)) {
      throw meridianError(
        "MRD-CF-ST-003",
        `state key "${key}" uses reserved prefix "state::"`,
        { context: { key } },
      );
    }
    const byteLen = new TextEncoder().encode(key).length;
    if (byteLen > KEY_MAX_BYTES) {
      throw meridianError(
        "MRD-CF-ST-001",
        `state key is ${byteLen} bytes, exceeds 1024-byte limit`,
        { context: { keyByteLength: byteLen, limit: KEY_MAX_BYTES } },
      );
    }
  }

  private validateValueSize(value: unknown, key: string): void {
    // JSON.stringify returns undefined for non-serializable values
    // (functions, undefined at the top level). DO storage accepts
    // them via structured clone, but callers shouldn't write those
    // through the Meridian API; skipping the size check on
    // un-stringifiable values is a conservative choice. Real size
    // enforcement happens inside workerd for the true clone limit.
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      // Circular structures throw; let DO storage handle the error
      // with its own message.
      return;
    }
    if (serialized === undefined) return;
    const byteLen = new TextEncoder().encode(serialized).length;
    if (byteLen > VALUE_MAX_BYTES) {
      throw meridianError(
        "MRD-CF-ST-002",
        `state value for "${key}" is ${byteLen} bytes, exceeds 1 MB limit`,
        { context: { key, valueByteLength: byteLen, limit: VALUE_MAX_BYTES } },
      );
    }
  }
}
