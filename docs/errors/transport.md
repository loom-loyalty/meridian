# `MRD-CF-TR-*` — Transport errors

Message send + broadcast errors. See [RUNTIME-SPEC §4.4](../../specs/core/RUNTIME-SPEC.md#44-message-transport).

## `MRD-CF-TR-001` — payload exceeds 1 MB

**Category:** `invalid_argument` (HTTP 400) · **Retryable:** no

Outbound `send()` / `broadcast()` payload is larger than 1 MB. Hard
wire limit per RUNTIME-SPEC §4.4.

**Fix**

- Split the payload into chunks if it's a stream of records
- Compress before send if it's text-heavy
- Store the large artifact in R2 / KV and send a reference

## `MRD-CF-TR-002` — broadcast matched zero recipients

**Category:** `not_found` (HTTP 404) · **Retryable:** no

`broadcast(selector, payload)` found no agents matching the selector
in the sender's tenant-scoped registry shard. By design, broadcasts
never silently fan out to "some future agent that might spawn" —
match set is frozen at call time.

**Common causes**

- Broadcasting from an agent that's the only one in its domain
- Cross-domain broadcast with a `selector.domain` that doesn't exist
- Multi-tenant: the tenant has no other agents in the target domain

**Fix**

Spawn at least one recipient first, or catch this error and treat it
as a no-op when the zero-recipient case is expected.

## `MRD-CF-TR-003` — inbox partition full

**Category:** `resource_exhausted` (HTTP 429) · **Retryable:** yes

Per-`(sender, recipient)` inbox cap (1024 unconsumed messages) hit.
Prevents unbounded queue growth that would eventually breach the DO
storage 1 MB-per-key limit. Per-sender partitioning means one
misbehaving sender can't starve well-behaved ones.

**Fix**

- Recipient needs to drain its inbox via `drainInbox()` or consume
  via the `onMessage` hook
- If the sender is hot and recipient slow, consider a bounded-size
  adaptive backoff on the sender side
- Retryable: wait a few hundred ms and retry the send
