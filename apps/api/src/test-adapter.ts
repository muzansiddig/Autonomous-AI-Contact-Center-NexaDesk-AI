import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { testInboundMessageSchema } from "../../../shared/contracts.js";

export interface OutboundMessage {
  tenantId: string;
  conversationId: string;
  messageId: string;
  idempotencyKey: string;
  channelType: string;
  externalAccountId: string | null;
  externalConversationId: string | null;
  body: string;
}

export interface ChannelCapabilities {
  text: boolean;
  inboundWebhooks: boolean;
  deliveryReceipts: boolean;
  providerIdempotency: boolean;
}

export interface OutboundAdapter {
  readonly name: string;
  readonly capabilities: ChannelCapabilities;
  supports(channelType: string): boolean;
  send(message: OutboundMessage): Promise<{ status: "accepted"; providerMessageId: string }>;
  classifyError(error: unknown): ChannelDeliveryError;
}

export class ChannelDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly safeToRetry: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = "ChannelDeliveryError";
  }
}

export class TestOutboundAdapter implements OutboundAdapter {
  readonly name = "test";
  readonly capabilities: ChannelCapabilities = {
    text: true,
    inboundWebhooks: true,
    deliveryReceipts: true,
    providerIdempotency: true,
  };
  private readonly acceptedMessages = new Map<string, string>();

  supports(channelType: string): boolean {
    return channelType === "web";
  }

  async send(message: OutboundMessage): Promise<{ status: "accepted"; providerMessageId: string }> {
    let providerMessageId = this.acceptedMessages.get(message.idempotencyKey);
    if (!providerMessageId) {
      providerMessageId = `test-${randomUUID()}`;
      this.acceptedMessages.set(message.idempotencyKey, providerMessageId);
    }
    return { status: "accepted", providerMessageId };
  }

  classifyError(error: unknown): ChannelDeliveryError {
    if (error instanceof ChannelDeliveryError) return error;
    return new ChannelDeliveryError("DELIVERY_OUTCOME_UNKNOWN", false, false);
  }
}

export interface NormalizedInboundMessage {
  providerEventId: string;
  body: string;
}

export class TestInboundAdapter {
  readonly name = "test";

  normalize(payload: unknown): NormalizedInboundMessage | null {
    const parsed = testInboundMessageSchema.safeParse(payload);
    return parsed.success
      ? { providerEventId: `test-${parsed.data.eventId}`, body: parsed.data.body }
      : null;
  }
}

interface ClaimedOutboxMessage {
  tenantId: string;
  outboxId: string;
  conversationId: string;
  messageId: string;
  idempotencyKey: string;
  externalConversationId: string | null;
  body: string;
  attemptCount: number;
  maxAttempts: number;
}

export function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

async function recordEvent(
  client: PoolClient,
  item: ClaimedOutboxMessage,
  eventType: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO conversation_events
       (tenant_id, conversation_id, actor_type, event_type, control_version, metadata)
     SELECT $1, $2, 'system', $3, m.control_version, $4::jsonb
     FROM conversation_messages m
     WHERE m.tenant_id = $1 AND m.id = $5`,
    [item.tenantId, item.conversationId, eventType, JSON.stringify(metadata), item.messageId],
  );
}

async function markExpiredLeasesUnknown(pool: Pool): Promise<void> {
  await pool.query(
    `WITH expired AS (
       UPDATE outbox_events
       SET status = 'unknown', lease_owner = NULL, lease_expires_at = NULL,
           last_error_code = 'WORKER_LEASE_EXPIRED'
       WHERE status = 'processing' AND lease_expires_at <= now()
       RETURNING tenant_id, aggregate_id, payload->>'messageId' AS message_id
     ), updated AS (
       UPDATE conversation_messages m
       SET delivery_status = 'unknown', updated_at = now()
       FROM expired e
       WHERE m.tenant_id = e.tenant_id AND m.id = e.message_id::uuid
       RETURNING m.tenant_id, m.conversation_id, m.id, m.control_version
     )
     INSERT INTO conversation_events
       (tenant_id, conversation_id, actor_type, event_type, control_version, metadata)
     SELECT tenant_id, conversation_id, 'system', 'message_delivery_updated',
            control_version, jsonb_build_object('messageId', id, 'deliveryStatus', 'unknown',
                                                'errorCode', 'WORKER_LEASE_EXPIRED')
     FROM updated`,
  );
}

async function claimBatch(pool: Pool, workerId: string): Promise<ClaimedOutboxMessage[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<ClaimedOutboxMessage>(
      `WITH candidates AS (
         SELECT o.tenant_id, o.id
         FROM outbox_events o
         WHERE o.status = 'pending'
           AND o.event_type = 'message.send'
           AND o.available_at <= now()
         ORDER BY o.available_at, o.created_at
         FOR UPDATE OF o SKIP LOCKED
         LIMIT 10
       )
       UPDATE outbox_events o
       SET status = 'processing', attempts = attempts + 1,
           lease_owner = $1, lease_expires_at = now() + interval '60 seconds'
       FROM candidates candidate,
            conversations c,
            conversation_messages m,
            channel_connections ch
       WHERE o.tenant_id = candidate.tenant_id AND o.id = candidate.id
         AND c.tenant_id = o.tenant_id AND c.id = o.aggregate_id
         AND m.tenant_id = o.tenant_id AND m.id = (o.payload->>'messageId')::uuid
         AND ch.tenant_id = c.tenant_id AND ch.id = c.channel_connection_id
       RETURNING o.tenant_id AS "tenantId", o.id AS "outboxId",
         o.aggregate_id AS "conversationId", m.id AS "messageId",
         COALESCE(m.client_message_id::text, m.id::text) AS "idempotencyKey",
         c.external_conversation_id AS "externalConversationId",
         m.body, o.attempts AS "attemptCount", o.max_attempts AS "maxAttempts"`,
      [workerId],
    );
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function finishDelivery(
  pool: Pool,
  item: ClaimedOutboxMessage,
  workerId: string,
  adapter: OutboundAdapter,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{
      status: string;
      control_mode: "ai" | "human" | "paused";
      control_version: string;
      conversation_status: string;
      channel_status: string;
      configuration_status: string;
      channel_type: string;
      external_account_id: string | null;
      external_conversation_id: string | null;
      sender_type: "customer" | "agent" | "human" | "system";
      message_control_version: string | null;
      body: string;
      idempotency_key: string | null;
    }>(
      `SELECT o.status, c.control_mode, c.control_version::text, c.status AS conversation_status,
              ch.status AS channel_status, ch.configuration_status, ch.channel_type,
              ch.external_account_id, c.external_conversation_id,
              m.sender_type, m.control_version::text AS message_control_version,
              m.body, m.client_message_id::text AS idempotency_key
       FROM outbox_events o
       JOIN conversations c ON c.tenant_id = o.tenant_id AND c.id = o.aggregate_id
       JOIN channel_connections ch
         ON ch.tenant_id = c.tenant_id AND ch.id = c.channel_connection_id
       JOIN conversation_messages m
         ON m.tenant_id = o.tenant_id AND m.id = (o.payload->>'messageId')::uuid
       WHERE o.tenant_id = $1 AND o.id = $2 AND o.lease_owner = $3
       FOR UPDATE OF o, c`,
      [item.tenantId, item.outboxId, workerId],
    );
    const row = current.rows[0];
    if (!row || row.status !== "processing") {
      await client.query("ROLLBACK");
      return;
    }

    const controlMatches = row.message_control_version === row.control_version;
    const controlAllowsSend =
      (row.sender_type === "human" && row.control_mode !== "ai") ||
      (row.sender_type === "agent" && row.control_mode === "ai");
    if (
      row.conversation_status !== "open" ||
      row.channel_status !== "active" ||
      row.configuration_status !== "ready" ||
      !controlMatches ||
      !controlAllowsSend
    ) {
      await client.query(
        `UPDATE conversation_messages SET delivery_status = 'failed', updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [item.tenantId, item.messageId],
      );
      await client.query(
        `UPDATE outbox_events SET status = 'failed', last_error_code = 'SEND_POLICY_REJECTED',
                lease_owner = NULL, lease_expires_at = NULL
         WHERE tenant_id = $1 AND id = $2`,
        [item.tenantId, item.outboxId],
      );
      await recordEvent(client, item, "message_delivery_updated", {
        messageId: item.messageId,
        deliveryStatus: "failed",
        errorCode: "SEND_POLICY_REJECTED",
      });
      await client.query("COMMIT");
      return;
    }
    if (!adapter.supports(row.channel_type)) {
      throw new ChannelDeliveryError("UNSUPPORTED_CHANNEL", false, true);
    }

    const delivery = await adapter.send({
      tenantId: item.tenantId,
      conversationId: item.conversationId,
      messageId: item.messageId,
      idempotencyKey: row.idempotency_key ?? item.messageId,
      channelType: row.channel_type,
      externalAccountId: row.external_account_id,
      externalConversationId: row.external_conversation_id,
      body: row.body,
    });
    await client.query(
      `UPDATE conversation_messages
       SET delivery_status = 'accepted', external_message_id = $3, updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [item.tenantId, item.messageId, delivery.providerMessageId],
    );
    await client.query(
      `UPDATE outbox_events
       SET status = 'published', published_at = now(), lease_owner = NULL,
           lease_expires_at = NULL, last_error_code = NULL
       WHERE tenant_id = $1 AND id = $2`,
      [item.tenantId, item.outboxId],
    );
    await recordEvent(client, item, "message_delivery_updated", {
      messageId: item.messageId,
      deliveryStatus: "accepted",
      adapter: adapter.name,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    await scheduleFailure(pool, item, workerId, adapter.classifyError(error));
  } finally {
    client.release();
  }
}

async function scheduleFailure(
  pool: Pool,
  item: ClaimedOutboxMessage,
  workerId: string,
  failure: ChannelDeliveryError,
): Promise<void> {
  const canRetry =
    failure.retryable &&
    failure.safeToRetry &&
    item.attemptCount < item.maxAttempts;
  const status = canRetry ? "pending" : failure.safeToRetry ? "failed" : "unknown";
  const messageStatus = canRetry ? "queued" : status;
  const delay = Math.min(
    60_000,
    Math.max(0, failure.retryAfterMs ?? retryDelayMs(item.attemptCount)),
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE outbox_events
       SET status = $4,
           available_at = CASE WHEN $4 = 'pending' THEN now() + ($5 * interval '1 millisecond') ELSE available_at END,
           lease_owner = NULL, lease_expires_at = NULL, last_error_code = $6
       WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3
       RETURNING id`,
      [item.tenantId, item.outboxId, workerId, status, delay, failure.code],
    );
    if (!updated.rowCount) {
      await client.query("COMMIT");
      return;
    }
    await client.query(
      `UPDATE conversation_messages
       SET delivery_status = $3, updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [item.tenantId, item.messageId, messageStatus],
    );
    await recordEvent(client, item, "message_delivery_updated", {
      messageId: item.messageId,
      deliveryStatus: messageStatus,
      errorCode: failure.code,
      retryScheduled: canRetry,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function processOutboxBatch(pool: Pool, adapter: OutboundAdapter): Promise<number> {
  await markExpiredLeasesUnknown(pool);
  const workerId = randomUUID();
  const items = await claimBatch(pool, workerId);
  for (const item of items) {
    await finishDelivery(pool, item, workerId, adapter);
  }
  return items.length;
}
