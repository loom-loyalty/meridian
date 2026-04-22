/**
 * Scenario assertion helpers.
 *
 * Tiny synchronous assertion primitives used by conformance scenarios.
 * Every assertion throws on failure with a message the runner captures
 * into `ConformanceResult.reason`. We avoid pulling vitest / chai in
 * so adopters can run the suite from a plain node script if they want.
 */

export function expect<T>(
  actual: T,
  description: string,
): {
  toBe(expected: T): void;
  toEqual(expected: unknown): void;
  toDeepEqual(expected: unknown): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toBeGreaterThan(n: number): void;
  toBeGreaterThanOrEqual(n: number): void;
  toBeLessThan(n: number): void;
  toHaveLength(n: number): void;
  toThrow(pattern: RegExp): void;
} {
  return {
    toBe(expected) {
      if (actual !== expected) {
        throw new Error(
          `${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        );
      }
    },
    toEqual(expected) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          `${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        );
      }
    },
    toDeepEqual(expected) {
      if (!deepEqual(actual, expected)) {
        throw new Error(
          `${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        );
      }
    },
    toBeTruthy() {
      if (!actual) {
        throw new Error(
          `${description}: expected truthy, got ${JSON.stringify(actual)}`,
        );
      }
    },
    toBeFalsy() {
      if (actual) {
        throw new Error(
          `${description}: expected falsy, got ${JSON.stringify(actual)}`,
        );
      }
    },
    toBeDefined() {
      if (actual === undefined) {
        throw new Error(`${description}: expected defined, got undefined`);
      }
    },
    toBeUndefined() {
      if (actual !== undefined) {
        throw new Error(
          `${description}: expected undefined, got ${JSON.stringify(actual)}`,
        );
      }
    },
    toBeGreaterThan(n: number) {
      if (typeof actual !== "number" || actual <= n) {
        throw new Error(
          `${description}: expected > ${n}, got ${JSON.stringify(actual)}`,
        );
      }
    },
    toBeGreaterThanOrEqual(n: number) {
      if (typeof actual !== "number" || actual < n) {
        throw new Error(
          `${description}: expected >= ${n}, got ${JSON.stringify(actual)}`,
        );
      }
    },
    toBeLessThan(n: number) {
      if (typeof actual !== "number" || actual >= n) {
        throw new Error(
          `${description}: expected < ${n}, got ${JSON.stringify(actual)}`,
        );
      }
    },
    toHaveLength(n: number) {
      const len = (actual as { length?: number })?.length;
      if (len !== n) {
        throw new Error(`${description}: expected length ${n}, got ${len}`);
      }
    },
    toThrow(_pattern: RegExp) {
      // toThrow is used with the async expectReject helper below;
      // the sync `toThrow` form would require a function arg. We keep
      // the sync API tiny and route error-match scenarios through
      // `expectReject`.
      throw new Error(
        `${description}: use expectReject(promise, pattern) for async throws`,
      );
    },
  };
}

/**
 * Assert a promise rejects with an error whose message matches the
 * given pattern. Scenarios use this for every `MRD-CF-*` error-code
 * check.
 */
export async function expectReject(
  promise: Promise<unknown>,
  pattern: RegExp,
  description: string,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const msg = (err as Error).message || String(err);
    if (!pattern.test(msg)) {
      throw new Error(
        `${description}: expected error matching ${pattern}, got "${msg}"`,
      );
    }
    return;
  }
  throw new Error(`${description}: expected rejection, but promise resolved`);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  const ak = Object.keys(a as Record<string, unknown>).sort();
  const bk = Object.keys(b as Record<string, unknown>).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    const k = ak[i]!;
    if (
      !deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      )
    ) {
      return false;
    }
  }
  return true;
}
