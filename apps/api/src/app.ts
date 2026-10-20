import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import type { Pool, PoolClient } from "pg";
import {
  assignConversationRequestSchema,
  agentSettingsRequestSchema,
  approvalDecisionRequestSchema,
  approvalDecisionHeadersSchema,
  approvalActionSchema,
  controlRequestSchema,
  listConversationsQuerySchema,
  listApprovalsQuerySchema,
  listTasksQuerySchema,
  messageSendHeadersSchema,
  sendMessageRequestSchema,
  timelineQuerySchema,
  uuidSchema,
  type ConversationDetail,
  type ConversationSummary,
  type ControlMode,
  type DirectoryMember,
  type DirectoryTeam,
  type DeliveryStatus,
  type MessageSummary,
  type ReadConversationResponse,
} from "../../../shared/contracts.js";
import {
  AgentProviderError,
  AgentRuntimeError,
  FakeAgentProvider,
  hashApprovalAction,
  runAgentTurn,
  type AgentProvider,
} from "./agent-runtime.js";
import type { AppConfig } from "./config.js";
import { createAuthentication, requestContext, requireRoles, sendError } from "./http.js";
import { createKnowledgeRouter } from "./knowledge.js";
import { OpenAIAgentProvider } from "./openai-agent-provider.js";
import { parseTelegramUpdate } from "./telegram-adapter.js";
import { TestInboundAdapter } from "./test-adapter.js";

interface ConversationRow {
  id: string;
  contact_id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  channel: string;
  control_mode: ControlMode;
  control_version: string;
  status: "open" | "closed";
  priority: "normal" | "high";
  subject: string | null;
  assigned_user_id: string | null;
  assigned_team_id: string | null;
  assignee_name: string | null;
  team_name: string | null;
  unread_count: number;
  last_message_id: string | null;
  last_message_direction: "inbound" | "outbound" | null;
  last_message_sender: "customer" | "agent" | "human" | "system" | null;
  last_message_body: string | null;
  last_message_status: DeliveryStatus | null;
  last_message_created_at: Date | null;
  tags?: string[];
  updated_at: Date;
}

interface Cursor {
  at: string;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "at" in parsed &&
      "id" in parsed &&
      typeof parsed.at === "string" &&
      !Number.isNaN(Date.parse(parsed.at)) &&
      typeof parsed.id === "string"
    ) {
      return { at: parsed.at, id: parsed.id };
    }
  } catch {
    return null;
  }
  return null;
}

function mapConversation(row: ConversationRow): ConversationSummary {
  const lastMessage: MessageSummary | null =
    row.last_message_id &&
    row.last_message_direction &&
    row.last_message_sender &&
    row.last_message_body !== null &&
    row.last_message_created_at
      ? {
          id: row.last_message_id,
          direction: row.last_message_direction,
          senderType: row.last_message_sender,
          body: row.last_message_body,
          deliveryStatus: row.last_message_status,
          createdAt: row.last_message_created_at.toISOString(),
        }
      : null;

  return {
    id: row.id,
    contact: {
      id: row.contact_id,
      displayName: row.display_name,
      email: row.email,
      phone: row.phone,
    },
    channel: row.channel,
    controlMode: row.control_mode,
    controlVersion: Number(row.control_version),
    status: row.status,
    priority: row.priority,
    subject: row.subject,
    assignee:
      row.assigned_user_id || row.assigned_team_id
        ? {
            ...(row.assigned_user_id ? { userId: row.assigned_user_id } : {}),
            ...(row.assigned_team_id ? { teamId: row.assigned_team_id } : {}),
            displayName: row.assignee_name ?? row.team_name ?? "",
          }
        : null,
    unreadCount: row.unread_count,
    lastMessage,
    updatedAt: row.updated_at.toISOString(),
  };
}

const conversationProjection = `
  SELECT c.id, c.contact_id, ct.display_name, ct.email, ct.phone,
         ch.channel_type AS channel, c.control_mode, c.control_version::text,
         c.status, c.priority, c.subject, c.assigned_user_id, c.assigned_team_id,
         u.display_name AS assignee_name, t.name AS team_name,
         c.unread_count, c.tags, c.updated_at,
         lm.id AS last_message_id, lm.direction AS last_message_direction,
         lm.sender_type AS last_message_sender, lm.body AS last_message_body,
         lm.delivery_status AS last_message_status, lm.created_at AS last_message_created_at
  FROM conversations c
  JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
  JOIN channel_connections ch ON ch.tenant_id = c.tenant_id AND ch.id = c.channel_connection_id
  LEFT JOIN tenant_memberships tm
    ON tm.tenant_id = c.tenant_id AND tm.user_id = c.assigned_user_id
  LEFT JOIN users u ON u.id = tm.user_id
  LEFT JOIN teams t ON t.tenant_id = c.tenant_id AND t.id = c.assigned_team_id
  LEFT JOIN LATERAL (
    SELECT m.id, m.direction, m.sender_type, m.body, m.delivery_status, m.created_at
    FROM conversation_messages m
    WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  ) lm ON true
`;

function conversationDetail(row: ConversationRow): ConversationDetail {
  return { ...mapConversation(row), tags: row.tags ?? [] };
}

function validatedId(value: string): string | null {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function queryError(res: Response, message = "The request parameters are invalid."): void {
  sendError(res, 400, "INVALID_REQUEST", message);
}

async function lockConversation(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
) {
  const result = await client.query<{
    control_mode: ControlMode;
    control_version: string;
    status: string;
  }>(
    `SELECT control_mode, control_version::text, status
     FROM conversations
     WHERE tenant_id = $1 AND id = $2
     FOR UPDATE`,
    [tenantId, conversationId],
  );
  return result.rows[0] ?? null;
}

async function changeControl(
  pool: Pool,
  req: Request,
  res: Response,
  mode: ControlMode,
): Promise<void> {
  const conversationId = validatedId(String(req.params.id));
  const parsed = controlRequestSchema.safeParse(req.body);
  if (!conversationId || !parsed.success || !req.auth) {
    queryError(res);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await lockConversation(client, req.auth.tenantId, conversationId);
    if (!current) {
      await client.query("ROLLBACK");
      sendError(res, 404, "CONVERSATION_NOT_FOUND", "The conversation was not found.");
      return;
    }
    const version = Number(current.control_version);
    if (version !== parsed.data.expectedControlVersion) {
      await client.query("ROLLBACK");
      sendError(res, 409, "STALE_CONTROL_VERSION", "The conversation control state has changed.", false, {
        currentControlMode: current.control_mode,
        currentControlVersion: version,
      });
      return;
    }
    if (current.status !== "open") {
      await client.query("ROLLBACK");
      sendError(res, 409, "CONVERSATION_CLOSED", "A closed conversation cannot change control mode.");
      return;
    }

    if (current.control_mode === mode) {
      await client.query("COMMIT");
      res.json({
        conversationId,
        controlMode: current.control_mode,
        controlVersion: version,
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    if (mode === "ai") {
      const blockers = await client.query<{ count: string }>(
        `SELECT (
           (SELECT count(*) FROM tasks
            WHERE tenant_id = $1 AND conversation_id = $2
              AND status IN ('running', 'waiting_approval', 'unknown'))
           +
           (SELECT count(*) FROM approval_requests a
            JOIN tasks t ON t.tenant_id = a.tenant_id AND t.id = a.task_id
            WHERE a.tenant_id = $1 AND t.conversation_id = $2 AND a.status = 'pending')
         )::text AS count`,
        [req.auth.tenantId, conversationId],
      );
      if (Number(blockers.rows[0].count) > 0) {
        await client.query("ROLLBACK");
        sendError(res, 409, "RESUME_BLOCKED", "Pending work or approvals must be resolved before AI is resumed.");
        return;
      }
    }

    const updated = await client.query<{ control_version: string; updated_at: Date }>(
      `UPDATE conversations
       SET control_mode = $3, control_version = control_version + 1, updated_at = now()
       WHERE tenant_id = $1 AND id = $2
       RETURNING control_version::text, updated_at`,
      [req.auth.tenantId, conversationId, mode],
    );
    await client.query(
      `UPDATE agent_runs SET status = 'stale', error_code = 'CONTROL_VERSION_CHANGED', updated_at = now()
       WHERE tenant_id = $1 AND conversation_id = $2 AND status = 'running'`,
      [req.auth.tenantId, conversationId],
    );
    await client.query(
      `INSERT INTO conversation_events
         (tenant_id, conversation_id, actor_type, actor_user_id, event_type,
          control_version, metadata)
       VALUES ($1, $2, 'user', $3, 'control_changed', $4, $5::jsonb)`,
      [
        req.auth.tenantId,
        conversationId,
        req.auth.userId,
        updated.rows[0].control_version,
        JSON.stringify({ from: current.control_mode, to: mode }),
      ],
    );
    await client.query("COMMIT");
    res.json({
      conversationId,
      controlMode: mode,
      controlVersion: Number(updated.rows[0].control_version),
      updatedAt: updated.rows[0].updated_at.toISOString(),
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function createApp(config: AppConfig, pool: Pool): Express {
  const app = express();
  const authenticate = createAuthentication(config, pool);
  const agentProvider: AgentProvider | null = config.agentProvider === "fake"
    ? new FakeAgentProvider()
    : config.agentProvider === "openai" && config.openAiApiKey
      ? new OpenAIAgentProvider({
          apiKey: config.openAiApiKey,
          model: config.openAiModel,
        })
      : null;
  const testInboundAdapter = config.devAuthEnabled ? new TestInboundAdapter() : null;
  app.disable("x-powered-by");
  app.use(requestContext);
  app.use(express.json({ limit: "32kb" }));

  app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get("/health/ready", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ready", database: "up" });
    } catch {
      sendError(res, 503, "NOT_READY", "The database is unavailable.", true);
    }
  });

  app.post("/webhooks/telegram/:channelId", async (req, res) => {
    if (!config.telegramBotToken || !config.telegramWebhookSecret) {
      sendError(res, 503, "TELEGRAM_WEBHOOK_UNAVAILABLE", "Telegram webhook credentials are not configured.", true);
      return;
    }
    const providedSecret = req.header("x-telegram-bot-api-secret-token");
    if (
      !providedSecret ||
      Buffer.byteLength(providedSecret) !== Buffer.byteLength(config.telegramWebhookSecret) ||
      !timingSafeEqual(
        Buffer.from(providedSecret),
        Buffer.from(config.telegramWebhookSecret),
      )
    ) {
      sendError(res, 401, "INVALID_WEBHOOK_SECRET", "The webhook authentication failed.");
      return;
    }
    const channelId = validatedId(String(req.params.channelId));
    const update = parseTelegramUpdate(req.body);
    if (!channelId || !update) {
      sendError(res, 400, "INVALID_TELEGRAM_UPDATE", "The Telegram update is invalid.");
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const channel = await client.query<{
        tenant_id: string;
        status: string;
        configuration_status: string;
      }>(
        `SELECT tenant_id, status, configuration_status
         FROM channel_connections
         WHERE id = $1 AND channel_type = 'telegram'`,
        [channelId],
      );
      const channelRow = channel.rows[0];
      if (!channelRow) {
        await client.query("ROLLBACK");
        sendError(res, 404, "TELEGRAM_CHANNEL_NOT_FOUND", "The Telegram channel was not found.");
        return;
      }
      if (channelRow.status !== "active" || channelRow.configuration_status !== "ready") {
        await client.query("ROLLBACK");
        sendError(res, 409, "TELEGRAM_CHANNEL_NOT_READY", "The Telegram channel is not ready to receive messages.");
        return;
      }

      const providerEventId = String(update.kind === "text" ? update.value.updateId : update.updateId);
      const eventType = update.kind === "text" ? "message" : "unsupported";
      const payloadHash = createHash("sha256").update(JSON.stringify(req.body)).digest("hex");
      const recorded = await client.query(
        `INSERT INTO channel_webhook_events
           (tenant_id, channel_connection_id, provider_event_id, event_type, payload_hash)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, channel_connection_id, provider_event_id) DO NOTHING
         RETURNING provider_event_id`,
        [channelRow.tenant_id, channelId, providerEventId, eventType, payloadHash],
      );
      if (!recorded.rowCount) {
        await client.query("COMMIT");
        res.json({ ok: true, duplicate: true });
        return;
      }
      if (update.kind === "ignored") {
        await client.query(
          `UPDATE channel_webhook_events
           SET status = 'ignored', processed_at = now()
           WHERE tenant_id = $1 AND channel_connection_id = $2 AND provider_event_id = $3`,
          [channelRow.tenant_id, channelId, providerEventId],
        );
        await client.query("COMMIT");
        res.json({ ok: true, ignored: true });
        return;
      }

      const inbound = update.value;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${channelRow.tenant_id}:${channelId}:${inbound.chatId}`],
      );
      let conversation = await client.query<{ id: string }>(
        `SELECT id FROM conversations
         WHERE tenant_id = $1 AND channel_connection_id = $2
           AND external_conversation_id = $3
         FOR UPDATE`,
        [channelRow.tenant_id, channelId, inbound.chatId],
      );
      if (!conversation.rows[0]) {
        let contact = await client.query<{ id: string }>(
          `SELECT id FROM contacts
           WHERE tenant_id = $1 AND channel_connection_id = $2
             AND external_contact_id = $3
           FOR UPDATE`,
          [channelRow.tenant_id, channelId, inbound.senderId],
        );
        if (!contact.rows[0]) {
          const createdContact = await client.query<{ id: string }>(
            `INSERT INTO contacts
               (tenant_id, id, display_name, channel_connection_id, external_contact_id)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (tenant_id, channel_connection_id, external_contact_id)
               WHERE channel_connection_id IS NOT NULL AND external_contact_id IS NOT NULL
             DO NOTHING
             RETURNING id`,
            [
              channelRow.tenant_id,
              randomUUID(),
              inbound.displayName,
              channelId,
              inbound.senderId,
            ],
          );
          contact = createdContact.rowCount
            ? createdContact
            : await client.query<{ id: string }>(
                `SELECT id FROM contacts
                 WHERE tenant_id = $1 AND channel_connection_id = $2
                   AND external_contact_id = $3
                 FOR UPDATE`,
                [channelRow.tenant_id, channelId, inbound.senderId],
              );
        }
        if (!contact.rows[0]) throw new Error("Telegram contact upsert did not return a contact.");
        const createdConversation = await client.query<{ id: string }>(
          `INSERT INTO conversations
             (tenant_id, id, contact_id, channel_connection_id, external_conversation_id,
              control_mode, control_version, status, subject)
           VALUES ($1, $2, $3, $4, $5, 'ai', 0, 'open', 'محادثة Telegram')
           ON CONFLICT (tenant_id, channel_connection_id, external_conversation_id)
             WHERE external_conversation_id IS NOT NULL
           DO NOTHING
           RETURNING id`,
          [
            channelRow.tenant_id,
            randomUUID(),
            contact.rows[0].id,
            channelId,
            inbound.chatId,
          ],
        );
        conversation = createdConversation.rowCount
          ? createdConversation
          : await client.query<{ id: string }>(
              `SELECT id FROM conversations
               WHERE tenant_id = $1 AND channel_connection_id = $2
                 AND external_conversation_id = $3
               FOR UPDATE`,
              [channelRow.tenant_id, channelId, inbound.chatId],
            );
      }
      const conversationId = conversation.rows[0]?.id;
      if (!conversationId) throw new Error("Telegram conversation upsert did not return a conversation.");

      const externalMessageId = `telegram:${channelId}:${inbound.chatId}:${inbound.messageId}`;
      const messageId = randomUUID();
      const insertedMessage = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO conversation_messages
           (tenant_id, id, conversation_id, external_message_id, direction, sender_type, body)
         VALUES ($1, $2, $3, $4, 'inbound', 'customer', $5)
         ON CONFLICT (tenant_id, external_message_id) DO NOTHING
         RETURNING id, created_at`,
        [channelRow.tenant_id, messageId, conversationId, externalMessageId, inbound.body],
      );
      if (!insertedMessage.rowCount) {
        const existingMessage = await client.query<{ id: string; conversation_id: string }>(
          `SELECT id, conversation_id FROM conversation_messages
           WHERE tenant_id = $1 AND external_message_id = $2`,
          [channelRow.tenant_id, externalMessageId],
        );
        if (existingMessage.rows[0]?.conversation_id !== conversationId) {
          throw new Error("Telegram message identifier conflicts with a different conversation.");
        }
      } else {
        await client.query(
          `UPDATE conversations SET unread_count = unread_count + 1, updated_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [channelRow.tenant_id, conversationId],
        );
        await client.query(
          `INSERT INTO conversation_events
             (tenant_id, conversation_id, actor_type, event_type, metadata)
           VALUES ($1, $2, 'customer', 'message_created', $3::jsonb)`,
          [
            channelRow.tenant_id,
            conversationId,
            JSON.stringify({
              messageId,
              channelType: "telegram",
              providerEventId,
            }),
          ],
        );
      }
      await client.query(
        `UPDATE channel_webhook_events
         SET status = 'processed', processed_at = now()
         WHERE tenant_id = $1 AND channel_connection_id = $2 AND provider_event_id = $3`,
        [channelRow.tenant_id, channelId, providerEventId],
      );
      await client.query("COMMIT");
      res.status(insertedMessage.rowCount ? 201 : 200).json({
        ok: true,
        conversationId,
        messageId: insertedMessage.rows[0]?.id,
        duplicate: !insertedMessage.rowCount,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  app.use("/v1", authenticate);
  app.use("/v1/knowledge", createKnowledgeRouter(pool));

  app.post(
    "/v1/test/conversations/:id/inbound",
    requireRoles("agent", "supervisor", "tenant_admin"),
    async (req, res) => {
      if (!testInboundAdapter || !req.auth) {
        sendError(res, 404, "ROUTE_NOT_FOUND", "The requested API route was not found.");
        return;
      }
      const conversationId = validatedId(String(req.params.id));
      const inbound = testInboundAdapter.normalize(req.body);
      if (!conversationId || !inbound) {
        queryError(res, "The test inbound event is invalid.");
        return;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const conversation = await client.query<{ id: string }>(
          `SELECT id FROM conversations WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [req.auth.tenantId, conversationId],
        );
        if (!conversation.rows[0]) {
          await client.query("ROLLBACK");
          sendError(res, 404, "CONVERSATION_NOT_FOUND", "The conversation was not found.");
          return;
        }
        const messageId = randomUUID();
        const inserted = await client.query<{ created_at: Date }>(
          `INSERT INTO conversation_messages
             (tenant_id, id, conversation_id, external_message_id, direction, sender_type, body)
           VALUES ($1, $2, $3, $4, 'inbound', 'customer', $5)
           ON CONFLICT (tenant_id, external_message_id) DO NOTHING
           RETURNING created_at`,
          [req.auth.tenantId, messageId, conversationId, inbound.providerEventId, inbound.body],
        );
        if (!inserted.rowCount) {
          const existing = await client.query<{
            id: string;
            conversation_id: string;
            body: string;
            created_at: Date;
          }>(
            `SELECT id, conversation_id, body, created_at
             FROM conversation_messages
             WHERE tenant_id = $1 AND external_message_id = $2`,
            [req.auth.tenantId, inbound.providerEventId],
          );
          await client.query("COMMIT");
          if (existing.rows[0]?.conversation_id !== conversationId) {
            sendError(res, 409, "INBOUND_EVENT_REUSED", "This event identifier belongs to another conversation.");
            return;
          }
          res.status(200).json({
            id: existing.rows[0].id,
            direction: "inbound",
            senderType: "customer",
            body: existing.rows[0].body,
            deliveryStatus: null,
            createdAt: existing.rows[0].created_at.toISOString(),
            duplicate: true,
          });
          return;
        }
        await client.query(
          `UPDATE conversations
           SET unread_count = unread_count + 1, updated_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [req.auth.tenantId, conversationId],
        );
        await client.query(
          `INSERT INTO conversation_events
             (tenant_id, conversation_id, actor_type, event_type, metadata)
           VALUES ($1, $2, 'customer', 'message_created', $3::jsonb)`,
          [req.auth.tenantId, conversationId, JSON.stringify({ messageId })],
        );
        await client.query("COMMIT");
        res.status(201).json({
          id: messageId,
          direction: "inbound",
          senderType: "customer",
          body: inbound.body,
          deliveryStatus: null,
          createdAt: inserted.rows[0].created_at.toISOString(),
          duplicate: false,
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get("/v1/conversations", async (req, res) => {
    const parsed = listConversationsQuerySchema.safeParse(req.query);
    if (!parsed.success || !req.auth) {
      queryError(res);
      return;
    }
    const cursor = decodeCursor(parsed.data.cursor);
    if (
      (parsed.data.cursor && !cursor) ||
      (cursor && !uuidSchema.safeParse(cursor.id).success)
    ) {
      queryError(res, "The page cursor is invalid.");
      return;
    }
    const values: unknown[] = [req.auth.tenantId];
    const conditions = ["c.tenant_id = $1"];
    const add = (condition: (index: number) => string, value: unknown) => {
      values.push(value);
      conditions.push(condition(values.length));
    };
    if (parsed.data.controlMode) add((index) => `c.control_mode = $${index}`, parsed.data.controlMode);
    if (parsed.data.channel) add((index) => `ch.channel_type = $${index}`, parsed.data.channel);
    if (parsed.data.priority) add((index) => `c.priority = $${index}`, parsed.data.priority);
    if (parsed.data.assigneeId) add((index) => `c.assigned_user_id = $${index}`, parsed.data.assigneeId);
    if (parsed.data.teamId) add((index) => `c.assigned_team_id = $${index}`, parsed.data.teamId);
    if (parsed.data.unread) {
      conditions.push(parsed.data.unread === "true" ? "c.unread_count > 0" : "c.unread_count = 0");
    }
    if (parsed.data.query) {
      add(
        (index) => `        (c.id::text ILIKE $${index} OR ct.display_name ILIKE $${index} OR c.subject ILIKE $${index} OR lm.body ILIKE $${index})`,
        `%${parsed.data.query}%`,
      );
    }
    if (cursor) {
      values.push(cursor.at, cursor.id);
      conditions.push(`(c.updated_at, c.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(parsed.data.limit + 1);
    const result = await pool.query<ConversationRow>(
      `${conversationProjection}
       WHERE ${conditions.join(" AND ")}
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > parsed.data.limit;
    const rows = result.rows.slice(0, parsed.data.limit);
    const last = rows.at(-1);
    res.json({
      items: rows.map(mapConversation),
      nextCursor: hasMore && last ? encodeCursor({ at: last.updated_at.toISOString(), id: last.id }) : null,
    });
  });

  app.get("/v1/conversations/:id", async (req, res) => {
    const id = validatedId(String(req.params.id));
    if (!id || !req.auth) {
      queryError(res);
      return;
    }
    const result = await pool.query<ConversationRow>(
      `${conversationProjection} WHERE c.tenant_id = $1 AND c.id = $2`,
      [req.auth.tenantId, id],
    );
    if (!result.rows[0]) {
      sendError(res, 404, "CONVERSATION_NOT_FOUND", "The conversation was not found.");
      return;
    }
    res.json(conversationDetail(result.rows[0]));
  });

  app.post("/v1/conversations/:id/read", requireRoles("agent", "supervisor", "tenant_admin"), async (req, res) => {
    const id = validatedId(String(req.params.id));
    if (!id || !req.auth) {
      queryError(res);
      return;
    }
    const result = await pool.query<{ id: string; unread_count: number }>(
      `UPDATE conversations SET unread_count = 0
       WHERE tenant_id = $1 AND id = $2
       RETURNING id, unread_count`,
      [req.auth.tenantId, id],
    );
    const conversation = result.rows[0];
    if (!conversation) {
      sendError(res, 404, "CONVERSATION_NOT_FOUND", "The conversation was not found.");
      return;
    }
    res.json({
      conversationId: conversation.id,
      unreadCount: conversation.unread_count,
    } satisfies ReadConversationResponse);
  });

  app.get("/v1/conversations/:id/timeline", async (req, res) => {
    const id = validatedId(req.params.id);
    const parsed = timelineQuerySchema.safeParse(req.query);
    const cursor = parsed.success ? decodeCursor(parsed.data.cursor) : null;
    if (
      !id ||
      !parsed.success ||
      (parsed.data.cursor && !cursor) ||
      (cursor &&
        !uuidSchema.safeParse(cursor.id).success &&
        !/^[1-9]\d*$/.test(cursor.id)) ||
      !req.auth
    ) {
      queryError(res);
      return;
    }
    const conversation = await pool.query(
      "SELECT 1 FROM conversations WHERE tenant_id = $1 AND id = $2",
      [req.auth.tenantId, id],
    );
    if (conversation.rows.length === 0) {
      sendError(res, 404, "CONVERSATION_NOT_FOUND", "The conversation was not found.");
      return;
    }
    const values: unknown[] = [req.auth.tenantId, id];
    const before = cursor
      ? (values.push(cursor.at, cursor.id), `AND (item.created_at, item.item_id) < ($${values.length - 1}::timestamptz, $${values.length})`)
      : "";
    values.push(parsed.data.limit + 1);
    const result = await pool.query<{
      kind: "message" | "event";
      item_id: string;
      created_at: Date;
      body: string | null;
      direction: "inbound" | "outbound" | null;
      sender_type: string | null;
      delivery_status: DeliveryStatus | null;
      event_type: string | null;
      actor_type: string | null;
      metadata: Record<string, unknown> | null;
    }>(
      `SELECT * FROM (
         SELECT 'message'::text AS kind, m.id::text AS item_id, m.created_at,
                m.body, m.direction, m.sender_type, m.delivery_status,
                NULL::text AS event_type, NULL::text AS actor_type,
                NULL::jsonb AS metadata
         FROM conversation_messages m
         WHERE m.tenant_id = $1 AND m.conversation_id = $2
         UNION ALL
         SELECT 'event'::text AS kind, e.id::text AS item_id, e.created_at,
                NULL::text, NULL::text, NULL::text, NULL::text,
                e.event_type, e.actor_type, e.metadata
         FROM conversation_events e
         WHERE e.tenant_id = $1 AND e.conversation_id = $2
           AND e.event_type <> 'message_created'
       ) item
       WHERE true ${before}
       ORDER BY item.created_at DESC, item.item_id DESC
       LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > parsed.data.limit;
    const rows = result.rows.slice(0, parsed.data.limit);
    const last = rows.at(-1);
    res.json({
      items: rows.map((row) => {
        if (row.kind === "message" && row.direction && row.sender_type && row.body !== null) {
          return {
            kind: "message" as const,
            message: {
              id: row.item_id,
              direction: row.direction,
              senderType: row.sender_type as MessageSummary["senderType"],
              body: row.body,
              deliveryStatus: row.delivery_status,
              createdAt: row.created_at.toISOString(),
            },
          };
        }
        return {
          kind: "event" as const,
          id: row.item_id,
          eventType: row.event_type ?? "unknown",
          actorType: row.actor_type ?? "system",
          createdAt: row.created_at.toISOString(),
          metadata: row.metadata ?? {},
        };
      }),
      nextCursor: hasMore && last ? encodeCursor({ at: last.created_at.toISOString(), id: last.item_id }) : null,
    });
  });

  const writeRoles = requireRoles("agent", "supervisor", "tenant_admin");
  app.post("/v1/conversations/:id/takeover", writeRoles, async (req, res) => {
    await changeControl(pool, req, res, "human");
  });
  app.post("/v1/conversations/:id/pause-ai", writeRoles, async (req, res) => {
    await changeControl(pool, req, res, "paused");
  });
  app.post("/v1/conversations/:id/resume-ai", writeRoles, async (req, res) => {
    await changeControl(pool, req, res, "ai");
  });

  app.post("/v1/conversations/:id/assign", writeRoles, async (req, res) => {
    const conversationId = validatedId(String(req.params.id));
    const parsed = assignConversationRequestSchema.safeParse(req.body);
    if (!conversationId || !parsed.success || !req.auth) {
      queryError(res);
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await lockConversation(client, req.auth.tenantId, conversationId);
      if (!current) {
        await client.query("ROLLBACK");
        sendError(res, 404, "CONVERSATION_NOT_FOUND", "The conversation was not found.");
        return;
      }
      if (Number(current.control_version) !== parsed.data.expectedControlVersion) {
        await client.query("ROLLBACK");
        sendError(res, 409, "STALE_CONTROL_VERSION", "The conversation has changed.", false, {
          currentControlMode: current.control_mode,
          currentControlVersion: Number(current.control_version),
        });
        return;
      }
      if (parsed.data.assigneeUserId) {
        const assignee = await client.query(
          `SELECT 1 FROM tenant_memberships
           WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`,
          [req.auth.tenantId, parsed.data.assigneeUserId],
        );
        if (assignee.rowCount === 0) {
          await client.query("ROLLBACK");
          sendError(res, 422, "INVALID_ASSIGNEE", "The selected user is not an active member of this workspace.");
          return;
        }
      }
      if (parsed.data.teamId) {
        const team = await client.query(
          `SELECT 1 FROM teams WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
          [req.auth.tenantId, parsed.data.teamId],
        );
        if (team.rowCount === 0) {
          await client.query("ROLLBACK");
          sendError(res, 422, "INVALID_TEAM", "The selected team is not active in this workspace.");
          return;
        }
      }
      const updated = await client.query<{ control_version: string; updated_at: Date }>(
        `UPDATE conversations
         SET assigned_user_id = $3, assigned_team_id = $4,
             control_version = control_version + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2
         RETURNING control_version::text, updated_at`,
        [req.auth.tenantId, conversationId, parsed.data.assigneeUserId ?? null, parsed.data.teamId ?? null],
      );
      await client.query(
        `UPDATE agent_runs SET status = 'stale', error_code = 'CONTROL_VERSION_CHANGED', updated_at = now()
         WHERE tenant_id = $1 AND conversation_id = $2 AND status = 'running'`,
        [req.auth.tenantId, conversationId],
      );
      await client.query(
        `INSERT INTO conversation_events
           (tenant_id, conversation_id, actor_type, actor_user_id, event_type,
            control_version, metadata)
         VALUES ($1, $2, 'user', $3, 'conversation_assigned', $4, $5::jsonb)`,
        [
          req.auth.tenantId,
          conversationId,
          req.auth.userId,
          updated.rows[0].control_version,
          JSON.stringify({
            assigneeUserId: parsed.data.assigneeUserId ?? null,
            teamId: parsed.data.teamId ?? null,
          }),
        ],
      );
      await client.query("COMMIT");
      res.json({
        conversationId,
        assigneeUserId: parsed.data.assigneeUserId ?? null,
        teamId: parsed.data.teamId ?? null,
        controlVersion: Number(updated.rows[0].control_version),
        updatedAt: updated.rows[0].updated_at.toISOString(),
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/v1/conversations/:id/messages", writeRoles, async (req, res) => {
    const conversationId = validatedId(String(req.params.id));
    const parsed = sendMessageRequestSchema.safeParse(req.body);
    const headers = messageSendHeadersSchema.safeParse({
      "idempotency-key": req.header("idempotency-key"),
    });
    if (!conversationId || !parsed.success || !headers.success || !req.auth) {
      queryError(res, "A valid message body and Idempotency-Key header are required.");
      return;
    }
    if (headers.data["idempotency-key"] !== parsed.data.clientMessageId) {
      queryError(res, "The Idempotency-Key must match clientMessageId.");
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{
        id: string;
        conversation_id: string;
        body: string;
        delivery_status: DeliveryStatus;
        created_at: Date;
      }>(
        `SELECT id, conversation_id, body, delivery_status, created_at
         FROM conversation_messages
         WHERE tenant_id = $1 AND client_message_id = $2`,
        [req.auth.tenantId, parsed.data.clientMessageId],
      );
      if (existing.rows[0]) {
        const message = existing.rows[0];
        if (message.conversation_id !== conversationId || message.body !== parsed.data.body) {
          await client.query("ROLLBACK");
          sendError(res, 409, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for a different message.");
          return;
        }
        await client.query("COMMIT");
        res.status(202).json({
          message: {
            id: message.id,
            direction: "outbound",
            senderType: "human",
            body: message.body,
            deliveryStatus: message.delivery_status,
            createdAt: message.created_at.toISOString(),
          },
          adapter: "test",
        });
        return;
      }

      const current = await lockConversation(client, req.auth.tenantId, conversationId);
      if (!current) {
        await client.query("ROLLBACK");
        sendError(res, 404, "CONVERSATION_NOT_FOUND", "The conversation was not found.");
        return;
      }
      const version = Number(current.control_version);
      if (version !== parsed.data.expectedControlVersion) {
        await client.query("ROLLBACK");
        sendError(res, 409, "STALE_CONTROL_VERSION", "The conversation control state has changed.", false, {
          currentControlMode: current.control_mode,
          currentControlVersion: version,
        });
        return;
      }
      if (current.status !== "open" || current.control_mode === "ai") {
        await client.query("ROLLBACK");
        sendError(res, 409, "MANUAL_REPLY_NOT_ALLOWED", "Manual replies require an open conversation controlled by a human or paused AI.");
        return;
      }

      const messageId = randomUUID();
      const outboxId = randomUUID();
      const created = await client.query<{ created_at: Date }>(
        `INSERT INTO conversation_messages
           (tenant_id, id, conversation_id, client_message_id, direction, sender_type,
            sender_user_id, body, delivery_status, control_version)
         VALUES ($1, $2, $3, $4, 'outbound', 'human', $5, $6, 'queued', $7)
         RETURNING created_at`,
        [
          req.auth.tenantId,
          messageId,
          conversationId,
          parsed.data.clientMessageId,
          req.auth.userId,
          parsed.data.body,
          version,
        ],
      );
      await client.query(
        `INSERT INTO outbox_events (tenant_id, id, event_type, aggregate_id, payload)
         VALUES ($1, $2, 'message.send', $3, $4::jsonb)`,
        [
          req.auth.tenantId,
          outboxId,
          conversationId,
          JSON.stringify({ messageId }),
        ],
      );
      await client.query(
        `INSERT INTO conversation_events
           (tenant_id, conversation_id, actor_type, actor_user_id, event_type,
            control_version, metadata)
         VALUES ($1, $2, 'user', $3, 'message_created', $4, $5::jsonb)`,
        [
          req.auth.tenantId,
          conversationId,
          req.auth.userId,
          version,
          JSON.stringify({ messageId }),
        ],
      );
      await client.query(
        `UPDATE conversations SET updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [req.auth.tenantId, conversationId],
      );
      await client.query("COMMIT");
      res.status(202).json({
        message: {
          id: messageId,
          direction: "outbound",
          senderType: "human",
          body: parsed.data.body,
          deliveryStatus: "queued",
          createdAt: created.rows[0].created_at.toISOString(),
        },
        adapter: "test",
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/v1/messages/:id", async (req, res) => {
    const messageId = validatedId(String(req.params.id));
    if (!messageId || !req.auth) {
      queryError(res);
      return;
    }
    const result = await pool.query<{
      id: string;
      direction: "inbound" | "outbound";
      sender_type: MessageSummary["senderType"];
      body: string;
      delivery_status: DeliveryStatus | null;
      created_at: Date;
    }>(
      `SELECT id, direction, sender_type, body, delivery_status, created_at
       FROM conversation_messages WHERE tenant_id = $1 AND id = $2`,
      [req.auth.tenantId, messageId],
    );
    const row = result.rows[0];
    if (!row) {
      sendError(res, 404, "MESSAGE_NOT_FOUND", "The message was not found.");
      return;
    }
    res.json({
      id: row.id,
      direction: row.direction,
      senderType: row.sender_type,
      body: row.body,
      deliveryStatus: row.delivery_status,
      createdAt: row.created_at.toISOString(),
    } satisfies MessageSummary);
  });

  app.get("/v1/members", async (req, res) => {
    if (!req.auth) {
      sendError(res, 401, "UNAUTHENTICATED", "Authentication is required.");
      return;
    }
    const result = await pool.query<DirectoryMember>(
      `SELECT u.id AS "userId", u.display_name AS "displayName"
       FROM tenant_memberships tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.tenant_id = $1 AND tm.status = 'active' AND u.status = 'active'
       ORDER BY u.display_name, u.id`,
      [req.auth.tenantId],
    );
    res.json(result.rows);
  });

  app.get("/v1/teams", async (req, res) => {
    if (!req.auth) {
      sendError(res, 401, "UNAUTHENTICATED", "Authentication is required.");
      return;
    }
    const result = await pool.query<DirectoryTeam>(
      `SELECT id, name FROM teams
       WHERE tenant_id = $1 AND status = 'active'
       ORDER BY name, id`,
      [req.auth.tenantId],
    );
    res.json(result.rows);
  });

  app.get("/v1/channels", async (req, res) => {
    if (!req.auth) {
      sendError(res, 401, "UNAUTHENTICATED", "Authentication is required.");
      return;
    }
    const result = await pool.query<{
      id: string;
      channelType: string;
      status: "active" | "disabled" | "error";
      configurationStatus: "not_configured" | "ready" | "error";
      capabilities: Record<string, boolean>;
      lastCheckedAt: Date | null;
      lastErrorCode: string | null;
    }>(
      `SELECT id, channel_type AS "channelType", status,
              configuration_status AS "configurationStatus", capabilities,
              last_checked_at AS "lastCheckedAt", last_error_code AS "lastErrorCode"
       FROM channel_connections
       WHERE tenant_id = $1
       ORDER BY channel_type, id`,
      [req.auth.tenantId],
    );
    res.json(result.rows.map((channel) => ({
      ...channel,
      lastCheckedAt: channel.lastCheckedAt?.toISOString() ?? null,
    })));
  });

  app.get(
    "/v1/agent/settings",
    requireRoles("supervisor", "tenant_admin"),
    async (req, res) => {
      if (!req.auth) {
        sendError(res, 401, "UNAUTHENTICATED", "Authentication is required.");
        return;
      }
      const result = await pool.query<{ enabled: boolean; provider: "disabled" | "fake" | "openai" }>(
        `SELECT enabled, provider FROM tenant_agent_settings WHERE tenant_id = $1`,
        [req.auth.tenantId],
      );
      res.json(result.rows[0] ?? { enabled: false, provider: "disabled" });
    },
  );

  app.put(
    "/v1/agent/settings",
    requireRoles("tenant_admin"),
    async (req, res) => {
      const parsed = agentSettingsRequestSchema.safeParse(req.body);
      if (!parsed.success || !req.auth) {
        sendError(res, 400, "INVALID_REQUEST", "Agent settings are invalid.");
        return;
      }
      if (parsed.data.enabled && parsed.data.provider === "disabled") {
        sendError(res, 422, "AGENT_PROVIDER_REQUIRED", "Choose an enabled agent provider.");
        return;
      }
      if (parsed.data.provider !== "disabled" &&
          (!agentProvider || agentProvider.name !== parsed.data.provider)) {
        sendError(res, 409, "AGENT_PROVIDER_UNAVAILABLE", "The selected agent provider is not configured on this server.");
        return;
      }
      const result = await pool.query<{ enabled: boolean; provider: "disabled" | "fake" | "openai" }>(
        `INSERT INTO tenant_agent_settings
           (tenant_id, enabled, provider, system_instructions, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (tenant_id) DO UPDATE
         SET enabled = EXCLUDED.enabled, provider = EXCLUDED.provider,
             system_instructions = EXCLUDED.system_instructions, updated_at = now()
         RETURNING enabled, provider`,
        [req.auth.tenantId, parsed.data.enabled, parsed.data.provider, parsed.data.systemInstructions],
      );
      res.json(result.rows[0]);
    },
  );

  app.post(
    "/v1/conversations/:id/agent-runs",
    requireRoles("agent", "supervisor", "tenant_admin"),
    async (req, res) => {
      const conversationId = validatedId(String(req.params.id));
      if (!conversationId || !req.auth) {
        queryError(res);
        return;
      }
      if (!agentProvider) {
        sendError(res, 503, "AGENT_PROVIDER_DISABLED", "No agent provider is enabled on this server.");
        return;
      }
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const result = await runAgentTurn(
          pool,
          req.auth.tenantId,
          conversationId,
          agentProvider,
          controller.signal,
          req.requestId,
        );
        res.status(result.status === "completed" ? 202 : 200).json(result);
      } catch (error) {
        if (error instanceof AgentRuntimeError || error instanceof AgentProviderError) {
          sendError(res, error.status, error.code, error.message, error.status >= 500);
          return;
        }
        throw error;
      }
    },
  );

  app.get("/v1/tasks", async (req, res) => {
    const parsed = listTasksQuerySchema.safeParse({
      conversationId: req.query.conversationId,
      status: req.query.status,
      cursor: req.query.cursor,
      limit: req.query.limit,
    });
    const cursor = parsed.success ? decodeCursor(parsed.data.cursor) : null;
    if (
      !req.auth ||
      !parsed.success ||
      (parsed.success && parsed.data.cursor && !cursor) ||
      (cursor && !uuidSchema.safeParse(cursor.id).success)
    ) {
      queryError(res);
      return;
    }
    const values: unknown[] = [req.auth.tenantId];
    const conditions = ["tenant_id = $1"];
    if (parsed.data.conversationId) {
      values.push(parsed.data.conversationId);
      conditions.push(`conversation_id = $${values.length}`);
    }
    if (parsed.data.status) {
      values.push(parsed.data.status);
      conditions.push(`status = $${values.length}`);
    }
    if (cursor) {
      values.push(cursor.at, cursor.id);
      conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(parsed.data.limit + 1);
    const result = await pool.query<{ id: string; created_at: Date }>(
      `SELECT id, conversation_id AS "conversationId", task_type AS "taskType",
              status, attempt_count AS "attemptCount", result, error_code AS "errorCode",
              created_at, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM tasks WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > parsed.data.limit;
    const rows = result.rows.slice(0, parsed.data.limit);
    const last = rows.at(-1);
    res.json({
      items: rows.map((row) => ({
        ...row,
        canDecide: req.auth?.role === "supervisor" || req.auth?.role === "tenant_admin",
      })),
      nextCursor: hasMore && last ? encodeCursor({ at: last.created_at.toISOString(), id: last.id }) : null,
    });
  });

  app.get("/v1/tasks/:id", async (req, res) => {
    const id = validatedId(req.params.id);
    if (!id || !req.auth) {
      queryError(res);
      return;
    }
    const result = await pool.query(
      `SELECT id, conversation_id AS "conversationId", task_type AS "taskType",
              status, attempt_count AS "attemptCount", result, error_code AS "errorCode",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM tasks WHERE tenant_id = $1 AND id = $2`,
      [req.auth.tenantId, id],
    );
    if (!result.rows[0]) {
      sendError(res, 404, "TASK_NOT_FOUND", "The task was not found.");
      return;
    }
    res.json(result.rows[0]);
  });

  app.get("/v1/approvals", async (req, res) => {
    const parsed = listApprovalsQuerySchema.safeParse({
      conversationId: req.query.conversationId,
      status: req.query.status,
      cursor: req.query.cursor,
      limit: req.query.limit,
    });
    const cursor = parsed.success ? decodeCursor(parsed.data.cursor) : null;
    if (
      !req.auth ||
      !parsed.success ||
      (parsed.success && parsed.data.cursor && !cursor) ||
      (cursor && !uuidSchema.safeParse(cursor.id).success)
    ) {
      queryError(res);
      return;
    }
    const values: unknown[] = [req.auth.tenantId];
    const conditions = ["a.tenant_id = $1"];
    if (parsed.data.conversationId) {
      values.push(parsed.data.conversationId);
      conditions.push(`t.conversation_id = $${values.length}`);
    }
    if (parsed.data.status) {
      values.push(parsed.data.status);
      conditions.push(`a.status = $${values.length}`);
    }
    if (cursor) {
      values.push(cursor.at, cursor.id);
      conditions.push(`(a.created_at, a.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(parsed.data.limit + 1);
    const result = await pool.query<{ id: string; created_at: Date }>(
      `SELECT a.id, a.task_id AS "taskId", t.conversation_id AS "conversationId",
              a.status, a.requested_action AS "requestedAction", a.action_hash AS "actionHash",
              a.approved_by AS "approvedBy",
              a.expires_at AS "expiresAt", a.created_at, a.created_at AS "createdAt"
       FROM approval_requests a
       JOIN tasks t ON t.tenant_id = a.tenant_id AND t.id = a.task_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY a.created_at DESC, a.id DESC LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > parsed.data.limit;
    const rows = result.rows.slice(0, parsed.data.limit);
    const last = rows.at(-1);
    res.json({
      items: rows.map((row) => ({
        ...row,
        canDecide: req.auth?.role === "supervisor" || req.auth?.role === "tenant_admin",
      })),
      nextCursor: hasMore && last ? encodeCursor({ at: last.created_at.toISOString(), id: last.id }) : null,
    });
  });

  app.post(
    "/v1/approvals/:id/decision",
    requireRoles("supervisor", "tenant_admin"),
    async (req, res) => {
      const approvalId = validatedId(String(req.params.id));
      const parsed = approvalDecisionRequestSchema.safeParse(req.body);
      const headers = approvalDecisionHeadersSchema.safeParse({
        "idempotency-key": req.header("idempotency-key"),
      });
      if (!approvalId || !parsed.success || !headers.success || !req.auth) {
        queryError(res, "The approval decision is invalid.");
        return;
      }
      const idempotencyKey = headers.data["idempotency-key"];
      const requestHash = createHash("sha256")
        .update(`${parsed.data.decision}:${parsed.data.actionHash}`)
        .digest("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const approval = await client.query<{
          id: string;
          status: string;
          requested_action: unknown;
          action_hash: string | null;
          decision_idempotency_key: string | null;
          decision_request_hash: string | null;
          control_version: string | null;
          expires_at: Date | null;
          conversation_id: string | null;
          task_id: string;
        }>(
          `SELECT a.id, a.status, a.requested_action, a.action_hash,
                  a.decision_idempotency_key, a.decision_request_hash,
                  a.control_version::text, a.expires_at, t.conversation_id, t.id AS task_id
           FROM approval_requests a
           JOIN tasks t ON t.tenant_id = a.tenant_id AND t.id = a.task_id
           WHERE a.tenant_id = $1 AND a.id = $2
           FOR UPDATE OF a, t`,
          [req.auth.tenantId, approvalId],
        );
        const row = approval.rows[0];
        if (!row) {
          await client.query("ROLLBACK");
          sendError(res, 404, "APPROVAL_NOT_FOUND", "The approval request was not found.");
          return;
        }
        const action = approvalActionSchema.safeParse(row.requested_action);
        if (
          !action.success ||
          !row.action_hash ||
          hashApprovalAction(action.data) !== row.action_hash ||
          parsed.data.actionHash !== row.action_hash
        ) {
          await client.query("ROLLBACK");
          sendError(res, 409, "APPROVAL_ACTION_TAMPERED", "The approved action no longer matches its recorded parameters.");
          return;
        }
        if (row.decision_idempotency_key === idempotencyKey) {
          if (row.decision_request_hash !== requestHash) {
            await client.query("ROLLBACK");
            sendError(res, 409, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for a different approval decision.");
            return;
          }
          await client.query("COMMIT");
          res.json({
            approvalId,
            status: row.status,
            approvedBy: req.auth.userId,
            executionStatus: row.status === "approved" ? "not_implemented" : "not_applicable",
            executed: false,
            duplicate: true,
          });
          return;
        }
        if (row.status !== "pending") {
          await client.query("ROLLBACK");
          sendError(res, 409, "APPROVAL_NOT_PENDING", "This approval request has already been decided.");
          return;
        }
        if (row.expires_at && row.expires_at.getTime() <= Date.now()) {
          await client.query(
            `UPDATE approval_requests SET status = 'expired', updated_at = now()
             WHERE tenant_id = $1 AND id = $2`,
            [req.auth.tenantId, approvalId],
          );
          await client.query(
            `UPDATE tasks SET status = 'cancelled', updated_at = now()
             WHERE tenant_id = $1 AND id = $2`,
            [req.auth.tenantId, row.task_id],
          );
          if (row.conversation_id) {
            await client.query(
              `INSERT INTO conversation_events
                 (tenant_id, conversation_id, actor_type, event_type, control_version, metadata)
               VALUES ($1, $2, 'system', 'approval_expired', $3, $4::jsonb)`,
              [
                req.auth.tenantId,
                row.conversation_id,
                row.control_version,
                JSON.stringify({ approvalId, reason: "deadline_elapsed" }),
              ],
            );
          }
          await client.query("COMMIT");
          sendError(res, 409, "APPROVAL_EXPIRED", "This approval request has expired.");
          return;
        }
        if (row.conversation_id) {
          const conversation = await client.query<{
            status: string;
            control_mode: string;
            control_version: string;
          }>(
            `SELECT status, control_mode, control_version::text
             FROM conversations WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
            [req.auth.tenantId, row.conversation_id],
          );
          const current = conversation.rows[0];
          if (
            !current ||
            current.status !== "open" ||
            current.control_mode !== "ai" ||
            row.control_version === null ||
            current.control_version !== row.control_version
          ) {
            await client.query(
              `UPDATE approval_requests SET status = 'expired', updated_at = now()
               WHERE tenant_id = $1 AND id = $2`,
              [req.auth.tenantId, approvalId],
            );
            await client.query(
              `UPDATE tasks SET status = 'cancelled', updated_at = now()
               WHERE tenant_id = $1 AND id = $2`,
              [req.auth.tenantId, row.task_id],
            );
            await client.query(
              `INSERT INTO conversation_events
                 (tenant_id, conversation_id, actor_type, event_type, control_version, metadata)
               VALUES ($1, $2, 'system', 'approval_context_invalidated', $3, $4::jsonb)`,
              [
                req.auth.tenantId,
                row.conversation_id,
                current?.control_version ?? row.control_version,
                JSON.stringify({
                  approvalId,
                  reason: "conversation_control_changed",
                  actionHash: row.action_hash,
                }),
              ],
            );
            await client.query("COMMIT");
            sendError(res, 409, "APPROVAL_CONTEXT_STALE", "Conversation control changed; request a new approval.");
            return;
          }
        }
        const status = parsed.data.decision === "approve" ? "approved" : "rejected";
        await client.query(
          `UPDATE approval_requests
           SET status = $3, approved_by = $4, decision_idempotency_key = $5,
               decision_request_hash = $6, updated_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [req.auth.tenantId, approvalId, status, req.auth.userId, idempotencyKey, requestHash],
        );
        await client.query(
          `UPDATE tasks SET status = $3, updated_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [
            req.auth.tenantId,
            row.task_id,
            status === "approved" ? "approved_not_executed" : "cancelled",
          ],
        );
        if (row.conversation_id) {
          await client.query(
            `INSERT INTO conversation_events
               (tenant_id, conversation_id, actor_type, actor_user_id, event_type, control_version, metadata)
             VALUES ($1, $2, 'user', $3, 'approval_decision_recorded', $4, $5::jsonb)`,
            [
              req.auth.tenantId,
              row.conversation_id,
              req.auth.userId,
              row.control_version,
              JSON.stringify({
                approvalId,
                decision: status,
                actionType: action.data.type,
                actionHash: row.action_hash,
                executionStatus: status === "approved" ? "not_implemented" : "not_applicable",
                correlationId: req.requestId,
              }),
            ],
          );
        }
        await client.query("COMMIT");
        res.json({
          approvalId,
          status,
          approvedBy: req.auth.userId,
          executionStatus: status === "approved" ? "not_implemented" : "not_applicable",
          executed: false,
          duplicate: false,
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get("/v1/events", async (req, res) => {
    if (!req.auth) {
      sendError(res, 401, "UNAUTHENTICATED", "Authentication is required.");
      return;
    }
    const initialId = req.header("last-event-id") ?? req.query.after;
    const after = initialId === undefined ? 0 : Number(initialId);
    if (!Number.isSafeInteger(after) || after < 0) {
      queryError(res, "The event cursor must be a non-negative integer.");
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.write("retry: 3000\n\n");

    let cursor = after;
    let polling = false;
    let closed = false;
    const poll = async () => {
      if (closed || polling) return;
      polling = true;
      try {
        const events = await pool.query<{
          id: string;
          event_type: string;
          conversation_id: string;
          created_at: Date;
          metadata: Record<string, unknown>;
        }>(
          `SELECT id::text, event_type, conversation_id, created_at, metadata
           FROM conversation_events
           WHERE tenant_id = $1 AND id > $2
           ORDER BY id LIMIT 100`,
          [req.auth?.tenantId, cursor],
        );
        for (const event of events.rows) {
          cursor = Number(event.id);
          res.write(`id: ${event.id}\nevent: ${event.event_type}\ndata: ${JSON.stringify({
            id: event.id,
            type: event.event_type,
            conversationId: event.conversation_id,
            occurredAt: event.created_at.toISOString(),
            data: event.metadata,
          })}\n\n`);
        }
        if (events.rowCount === 0) res.write(": keep-alive\n\n");
      } catch {
        console.error(`SSE polling failed for request ${req.requestId}.`);
        res.write(`event: stream-error\ndata: ${JSON.stringify({ retryable: true })}\n\n`);
      } finally {
        polling = false;
      }
    };
    const interval = setInterval(() => void poll(), 2_000);
    res.on("close", () => {
      closed = true;
      clearInterval(interval);
    });
    await poll();
  });

  app.use((_req, res) => {
    sendError(res, 404, "ROUTE_NOT_FOUND", "The requested API route was not found.");
  });

  app.use((error: unknown, req: Request, res: Response, next: express.NextFunction) => {
    void next;
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      sendError(res, 400, "INVALID_JSON", "The request body is not valid JSON.");
      return;
    }
    if (typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large") {
      sendError(res, 413, "PAYLOAD_TOO_LARGE", "The request body exceeds the allowed size.");
      return;
    }
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error(`Request ${req.requestId} failed (${errorName}).`);
    sendError(res, 500, "INTERNAL_ERROR", "An unexpected server error occurred.", true);
  });

  return app;
}
