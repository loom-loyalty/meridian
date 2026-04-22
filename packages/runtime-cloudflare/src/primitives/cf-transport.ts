/**
 * Cloudflare implementation of the {@link TransportPlugin} seam.
 *
 * **Mailbox layout** (eng-review decision 2026-04-21): ONE
 * `AgentDurableObject` per recipient, with incoming messages
 * partitioned BY SENDER at the storage layer. Storage keys look like:
 *
 *     __mail::${fromAgentId}          → IncomingMessage[]
 *     __mail_seq::${fromAgentId}      → next sequence number
 *
 * This gives RUNTIME-SPEC §4.4's "at-least-once + in-order per
 * (sender, recipient) pair" guarantee without spawning N^2 DOs. The
 * DO's input gate serializes concurrent `deliver` calls to the same
 * recipient, so the read-modify-write of a per-sender array stays
 * atomic.
 *
 * Broadcast: queries the registry, fans out to the current matching
 * set, does NOT subscribe to future spawns (RUNTIME-SPEC §4.4
 * "matches selector at time of call; late-spawned agents don't
 * receive").
 *
 * `onDeliver` is invoked right after the message lands, letting the
 * hosting DO wire the adopter's `onMessage` hook in the same tick.
 */

import type {
  AgentId,
  AgentSelector,
  BroadcastReceipt,
  DomainId,
  IncomingMessage,
  MessageReceipt,
  Timestamp,
} from "@loom-loyalty/meridian-types";

import type { AgentDurableObject } from "../agent-do.js";
import { meridianError } from "../errors.js";
import type { RegistryDurableObject } from "../registry-do.js";
import type { TransportPlugin } from "./types.js";

const MAIL_PREFIX = "__mail::";
const PAYLOAD_MAX_BYTES = 1_000_000; // 1 MB per RUNTIME-SPEC §4.4

/**
 * Per-(sender, recipient) inbox cap. A single sender can't queue
 * more than this many unconsumed messages to one recipient before
 * `deliver` rejects with MRD-CF-TR-003. Prevents an unbounded
 * queue growth that would eventually breach the DO's 1 MB/key
 * storage limit as a silent workerd error. Chosen conservatively:
 * 1024 backlog entries × (modest payload) stays well under 1 MB.
 * Per-sender partitioning means a misbehaving sender can't
 * starve well-behaved senders' mailboxes.
 */
const INBOX_MAX_PER_SENDER = 1024;

/**
 * Per-sender mailbox partition. The inbox + next-sequence counter
 * live in ONE storage value under key `__mail::${fromAgentId}` so a
 * single `put` is atomic for both fields. The prior "inbox +
 * seq-counter in two separate keys with two separate puts" design
 * had a crash window where the seq counter could lag the inbox and
 * lead to duplicate messageIds on retry.
 */
interface MailPartition {
  inbox: IncomingMessage[];
  nextSeq: number;
}

type AnyDurableObjectNamespace = Pick<
  DurableObjectNamespace,
  "idFromName" | "newUniqueId" | "idFromString" | "get"
>;

export interface TransportEnv {
  AGENT: AnyDurableObjectNamespace;
  REGISTRY: DurableObjectNamespace<RegistryDurableObject>;
}

const REGISTRY_SHARD_KEY = "default";

/**
 * Async callback invoked on each received message, after the storage
 * write lands. The hosting DO uses this slot to invoke the adopter's
 * `onMessage` hook in the same request.
 */
export type DeliverHook = (msg: IncomingMessage) => Promise<void>;

export class CfTransportPlugin implements TransportPlugin {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: TransportEnv,
    /** Called to resolve the current agent id at send-time. */
    private readonly getAgentId: () => Promise<AgentId>,
    /** Called to resolve the current agent's domain. */
    private readonly getDomain: () => Promise<DomainId>,
    /**
     * Hook invoked right after each `deliver()` succeeds. Optional
     * in M2c; when absent, deliver just appends to the inbox. When
     * present (defineAgent onMessage wired), this fires the hook.
     */
    private readonly onDeliver: DeliverHook | undefined = undefined,
  ) {}

  async send(toAgentId: AgentId, payload: Uint8Array): Promise<MessageReceipt> {
    this.validatePayload(payload);
    const fromAgentId = await this.getAgentId();
    const target = this.env.AGENT.get(
      this.env.AGENT.idFromName(toAgentId),
    ) as unknown as DurableObjectStub<AgentDurableObject>;
    const incoming = await target.deliver(fromAgentId, payload);
    return {
      messageId: incoming.messageId,
      queuedAt: incoming.receivedAt,
    };
  }

  async broadcast(
    selector: AgentSelector,
    payload: Uint8Array,
  ): Promise<BroadcastReceipt> {
    this.validatePayload(payload);
    const fromAgentId = await this.getAgentId();
    const myDomain = await this.getDomain();

    // Registry ONLY tracks registered agents at this point in the
    // request. Late-spawned agents won't be in the list and therefore
    // won't receive — matches RUNTIME-SPEC §4.4 semantics.
    const registry = this.env.REGISTRY.get(
      this.env.REGISTRY.idFromName(REGISTRY_SHARD_KEY),
    );
    const all = await registry.list();

    // Domain filter: if selector.domain is set, require match. If
    // selector is domain-less, match within the sender's own domain
    // (broadcast within your own domain is the safe default; the
    // sender can still opt into cross-domain via explicit selector).
    const targetDomain = selector.domain ?? myDomain;
    const matched = all.filter(
      (a) => a.domain === targetDomain && a.id !== fromAgentId,
    );

    if (matched.length === 0) {
      throw meridianError(
        "MRD-CF-TR-002",
        `broadcast selector matched 0 registered agents in domain "${targetDomain}"`,
        { context: { selector, domain: targetDomain } },
      );
    }

    const broadcastId = crypto.randomUUID();
    const queuedAt = Date.now();

    // Fan out in parallel. Individual delivery failures are logged
    // but do not fail the broadcast — matches the "best effort"
    // semantic from the spec. Recipient count reported is the set
    // we attempted; per-recipient success is not tracked here
    // (M2d observability wires that).
    await Promise.allSettled(
      matched.map(async (agent) => {
        const target = this.env.AGENT.get(
          this.env.AGENT.idFromName(agent.id),
        ) as unknown as DurableObjectStub<AgentDurableObject>;
        try {
          await target.deliver(fromAgentId, payload);
        } catch (err) {
          console.warn(
            `[broadcast ${broadcastId}] delivery to ${agent.id} failed: ${(err as Error).message}`,
          );
        }
      }),
    );

    return {
      broadcastId,
      recipientCount: matched.length,
      queuedAt,
    };
  }

  async deliver(
    fromAgentId: AgentId,
    payload: Uint8Array,
  ): Promise<IncomingMessage> {
    // Validation re-runs on the receive side — defense in depth for
    // cases where a sender bypassed send() (e.g. direct RPC from a
    // misconfigured adopter worker).
    this.validatePayload(payload);

    const now = Date.now();
    const myId = await this.getAgentId();
    const mailKey = `${MAIL_PREFIX}${fromAgentId}`;

    // Load the combined partition. DO input gate serializes concurrent
    // `deliver` calls to this DO so the read/check/write sequence stays
    // consistent — and because inbox + nextSeq live under ONE key,
    // a single `put` persists both atomically. Prior design had them
    // as two keys with two puts; a crash between left the seq lagging
    // the inbox and produced duplicate messageIds on retry.
    const partition = (await this.ctx.storage.get<MailPartition>(mailKey)) ?? {
      inbox: [],
      nextSeq: 0,
    };

    // Cap check FIRST — no seq burn, no messageId ghost on a rejected
    // delivery. Partitioning means this bounds the offending
    // (sender, recipient) pair without affecting deliveries from
    // other senders.
    if (partition.inbox.length >= INBOX_MAX_PER_SENDER) {
      throw meridianError(
        "MRD-CF-TR-003",
        `inbox partition from ${fromAgentId} to ${myId} is at ${INBOX_MAX_PER_SENDER}-message cap; drain or retry later`,
        {
          context: {
            fromAgentId,
            toAgentId: myId,
            queued: partition.inbox.length,
            cap: INBOX_MAX_PER_SENDER,
          },
        },
      );
    }

    const nextSeq = partition.nextSeq + 1;
    const msg: IncomingMessage = {
      messageId: `${fromAgentId}::${nextSeq}`,
      fromAgentId,
      toAgentId: myId,
      payload,
      receivedAt: now,
    };

    partition.inbox.push(msg);
    partition.nextSeq = nextSeq;
    await this.ctx.storage.put(mailKey, partition);

    if (this.onDeliver) {
      // Hook errors don't bubble to the sender; log and swallow so
      // one bad handler doesn't DoS the transport layer.
      try {
        await this.onDeliver(msg);
      } catch (err) {
        console.warn(
          `[transport] onDeliver hook for ${myId} from ${fromAgentId} threw: ${(err as Error).message}`,
        );
      }
    }

    return msg;
  }

  async receiveAll(): Promise<IncomingMessage[]> {
    return this.readMailbox();
  }

  async drainAll(): Promise<IncomingMessage[]> {
    // Read-then-clear. Input-gate serialization means no concurrent
    // deliver() can interleave with this. Sequence counters live
    // inside each partition value, so to preserve monotonic
    // messageIds across drains we rewrite each partition with an
    // empty inbox but its prior nextSeq — one `put` per partition,
    // each atomic. A crash mid-loop leaves drained partitions as
    // {inbox:[], nextSeq:N} and un-drained partitions intact. The
    // caller already holds the full snapshot in `all`, so
    // un-drained partitions (if any) would be double-delivered on
    // the next drain. For M2d acceptably rare (drain doesn't throw
    // mid-loop under workerd); M2e may revisit with a true txn.
    const partitions = await this.ctx.storage.list<MailPartition>({
      prefix: MAIL_PREFIX,
    });
    const all: IncomingMessage[] = [];
    for (const [key, partition] of partitions) {
      for (const m of partition.inbox) all.push(m);
      await this.ctx.storage.put(key, {
        inbox: [],
        nextSeq: partition.nextSeq,
      });
    }
    this.sortMailbox(all);
    return all;
  }

  // ── internal ─────────────────────────────────────────────

  private validatePayload(payload: Uint8Array): void {
    if (payload.byteLength > PAYLOAD_MAX_BYTES) {
      throw meridianError(
        "MRD-CF-TR-001",
        `payload ${payload.byteLength} bytes exceeds 1 MB wire limit`,
        {
          context: {
            payloadBytes: payload.byteLength,
            limit: PAYLOAD_MAX_BYTES,
          },
        },
      );
    }
  }

  /**
   * Read every per-sender inbox, merge into one arrival-ordered list.
   * Ordering across senders is by `receivedAt` (workerd's single-
   * threaded input gate makes wall-clock ordering well-defined).
   * Within a single sender, the per-pair sequence is preserved by
   * push-order in the stored array.
   */
  private async readMailbox(): Promise<IncomingMessage[]> {
    const partitions = await this.ctx.storage.list<MailPartition>({
      prefix: MAIL_PREFIX,
    });
    const combined: IncomingMessage[] = [];
    for (const partition of partitions.values()) {
      for (const m of partition.inbox) combined.push(m);
    }
    this.sortMailbox(combined);
    return combined;
  }

  /**
   * Cross-sender arrival-ordered sort with tie-break semantics:
   *   1. receivedAt ascending (primary — wall-clock order)
   *   2. fromAgentId lexicographic (secondary — deterministic)
   *   3. NUMERIC per-sender sequence (tertiary — preserves
   *      in-order-per-pair when two messages from the same sender
   *      share a millisecond, which lexicographic sort of the
   *      messageId would get wrong: `sender::10` < `sender::2`).
   */
  private sortMailbox(msgs: IncomingMessage[]): void {
    msgs.sort((a: IncomingMessage, b: IncomingMessage) => {
      const byTime = (a.receivedAt as Timestamp) - (b.receivedAt as Timestamp);
      if (byTime !== 0) return byTime;
      if (a.fromAgentId !== b.fromAgentId) {
        return a.fromAgentId.localeCompare(b.fromAgentId);
      }
      const aSeq = Number(a.messageId.split("::").at(-1) ?? 0);
      const bSeq = Number(b.messageId.split("::").at(-1) ?? 0);
      return aSeq - bSeq;
    });
  }
}
