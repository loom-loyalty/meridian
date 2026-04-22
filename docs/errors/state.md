# `MRD-CF-ST-*` — State errors

State persistence errors. See [RUNTIME-SPEC §4.2](../../specs/core/RUNTIME-SPEC.md#42-state-persistence).

## `MRD-CF-ST-001` — state key too large

**Category:** `invalid_argument` (HTTP 400) · **Retryable:** no

State key exceeds 1024 bytes (UTF-8 encoded). Hard limit per
RUNTIME-SPEC §4.2.

**Fix**

Shorten the key. If you're encoding structured info into the key
itself, move the variable part into the value and namespace the key
with a small prefix (e.g. `users/` + hash).

## `MRD-CF-ST-002` — state value too large

**Category:** `invalid_argument` (HTTP 400) · **Retryable:** no

Serialized state value exceeds 1 MB. The adapter JSON-encodes values
before storage; some characters (control chars, emoji) expand the
byte size past what the raw string suggests.

**Fix**

Chunk large values across multiple keys, or move the payload out of
DO state into R2 / KV and store only a reference. 1 MB is a hard
Cloudflare DO limit per key, not a Meridian-imposed one.

## `MRD-CF-ST-003` — reserved key

**Category:** `invalid_argument` (HTTP 400) · **Retryable:** no

State key is empty, matches a reserved prefix (`__`, `state::`), or
conflicts with a runtime-owned key (`__meta__`, `__terminated__`,
`__mail::*`, `__mail_seq::*`, `__schedules__`, `__fired__`).

**Fix**

Rename the key without the reserved prefix. Adopters own every key
that doesn't start with `__`.
