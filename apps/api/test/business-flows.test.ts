import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  runAgentTurn,
  type AgentContext,
  type AgentProvider,
} from "../src/agent-runtime.js";
import {
  processOutboxBatch,
  TestOutboundAdapter,
} from "../src/test-adapter.js";

const config = loadConfig({
  ...process.env,
  NODE_ENV: "test",
  AGENT_PROVIDER: "fake",
});
if (!config.devAuthEnabled) {
  throw new Error("Business flow tests require DEV_AUTH_ENABLED=true and a local development token.");
}

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const app = createApp(config, pool);
const authHeaders = { Authorization: `Bearer ${config.devAuthToken}` };

const tenantId = config.devTenantId;
const channelId = randomUUID();
const contactId = randomUUID();
const conversationId = randomUUID();
const teamId = randomUUID();
const knowledgeSourceKey = `bf-knowledge-${randomUUID()}`;
let ready = false;

class KnowledgeGroundedProvider implements AgentProvider {
  readonly name = "fake";
  async generate(context: AgentContext, _signal: AbortSignal): Promise<unknown> {
    const hasKnowledge = context.authorizedKnowledge.length > 0;
    return {
      type: "respond",
      body: hasKnowledge
        ? `بناءً على سياسة المتجر: ${context.authorizedKnowledge[0]}`
        : "لا تتوفر معلومات حول هذا الطلب.",
      usage: { promptTokens: 30, completionTokens: 15 },
    };
  }
}

class RefundApprovalProvider implements AgentProvider {
  readonly name = "fake";
  async generate(_context: AgentContext, _signal: AbortSignal): Promise<unknown> {
    return {
      type: "request_approval",
      action: { type: "refund", orderReference: "ORD-FLOW-77", amount: 150 },
      usage: { promptTokens: 25, completionTokens: 10 },
    };
  }
}

class SlowProvider implements AgentProvider {
  readonly name = "fake";
  private unblock!: () => void;
  readonly blocked = new Promise<void>((resolve) => {
    this.unblock = resolve;
  });

  async generate(_context: AgentContext, signal: AbortSignal): Promise<unknown> {
    await this.blocked;
    if (signal.aborted) throw new Error("aborted");
    return {
      type: "respond",
      body: "رد متأخر من الوكيل",
      usage: { promptTokens: 10, completionTokens: 5 },
    };
  }

  release(): void {
    this.unblock();
  }
}

before(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO channel_connections
         (tenant_id, id, channel_type, external_account_id, configuration_status, capabilities)
       VALUES ($1, $2, 'web', $3, 'ready', '{"text":true,"providerIdempotency":true}'::jsonb)`,
      [tenantId, channelId, `bf-${channelId}`],
    );
    await client.query(
      "INSERT INTO contacts (tenant_id, id, display_name) VALUES ($1, $2, 'Business Flow Contact')",
      [tenantId, contactId],
    );
    await client.query(
      "INSERT INTO teams (tenant_id, id, name) VALUES ($1, $2, 'فريق التدقيق')",
      [tenantId, teamId],
    );
    await client.query(
      `INSERT INTO conversations
         (tenant_id, id, contact_id, channel_connection_id, control_mode, control_version, subject, status)
       VALUES ($1, $2, $3, $4, 'ai', 0, 'Business Flow E2E Test', 'open')`,
      [tenantId, conversationId, contactId, channelId],
    );
    await client.query(
      `INSERT INTO tenant_agent_settings (tenant_id, enabled, provider, system_instructions)
       VALUES ($1, true, 'fake', 'Business flow system instructions.')
       ON CONFLICT (tenant_id) DO UPDATE SET enabled = true, provider = 'fake'`,
      [tenantId],
    );
    await client.query("COMMIT");
    ready = true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

after(async () => {
  if (ready) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM knowledge_documents WHERE tenant_id = $1 AND source_key = $2", [tenantId, knowledgeSourceKey]);
      await client.query(
        `DELETE FROM approval_requests WHERE tenant_id = $1 AND task_id IN (
           SELECT id FROM tasks WHERE tenant_id = $1 AND conversation_id = $2
         )`,
        [tenantId, conversationId],
      );
      await client.query("DELETE FROM tasks WHERE tenant_id = $1 AND conversation_id = $2", [tenantId, conversationId]);
      await client.query("DELETE FROM outbox_events WHERE tenant_id = $1 AND aggregate_id = $2", [tenantId, conversationId]);
      await client.query("DELETE FROM conversation_events WHERE tenant_id = $1 AND conversation_id = $2", [tenantId, conversationId]);
      await client.query("DELETE FROM agent_runs WHERE tenant_id = $1 AND conversation_id = $2", [tenantId, conversationId]);
      await client.query("DELETE FROM conversation_messages WHERE tenant_id = $1 AND conversation_id = $2", [tenantId, conversationId]);
      await client.query("DELETE FROM conversations WHERE tenant_id = $1 AND id = $2", [tenantId, conversationId]);
      await client.query("DELETE FROM contacts WHERE tenant_id = $1 AND id = $2", [tenantId, contactId]);
      await client.query("DELETE FROM teams WHERE tenant_id = $1 AND id = $2", [tenantId, teamId]);
      await client.query("DELETE FROM channel_connections WHERE tenant_id = $1 AND id = $2", [tenantId, channelId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  await pool.end();
});

describe("Complete business-flow integration", () => {
  it("executes: inbound test message -> knowledge search -> agent response -> outbox delivery -> audit trail", async () => {
    // 1. Upload knowledge document
    await request(app)
      .post("/v1/knowledge/documents")
      .set(authHeaders)
      .send({
        sourceKey: knowledgeSourceKey,
        sourceName: "سياسة الاستبدال السريع",
        mediaType: "text/markdown",
        content: "سياسة الاستبدال: يحق للعميل استبدال المنتجات التالفة مجانًا خلال 3 أيام من الاستلام.",
      })
      .expect(201);

    // 2. Inbound customer message
    const inboundEventId = randomUUID();
    const inbound = await request(app)
      .post(`/v1/test/conversations/${conversationId}/inbound`)
      .set(authHeaders)
      .send({ eventId: inboundEventId, body: "كيف يتم استبدال المنتجات التالفة؟" })
      .expect(201);
    assert.equal(inbound.body.direction, "inbound");

    // 3. Run agent turn with knowledge search
    const agentRun = await runAgentTurn(
      pool,
      tenantId,
      conversationId,
      new KnowledgeGroundedProvider(),
    );
    assert.equal(agentRun.status, "completed");
    assert.equal(agentRun.decisionType, "respond");
    assert.ok(agentRun.messageId);

    // 4. Verify outbox event was created and process delivery
    const outboxCount = await processOutboxBatch(pool, new TestOutboundAdapter());
    assert.ok(outboxCount >= 1);

    // 5. Message delivery status updated
    const delivered = await request(app)
      .get(`/v1/messages/${agentRun.messageId}`)
      .set(authHeaders)
      .expect(200);
    assert.equal(delivered.body.deliveryStatus, "accepted");
    assert.ok(delivered.body.body.includes("الاستبدال"));

    // 6. Audit trail verification in conversation events and messages
    const timeline = await request(app)
      .get(`/v1/conversations/${conversationId}/timeline`)
      .set(authHeaders)
      .expect(200);
    const eventTypes = timeline.body.items
      .filter((i: { kind: string }) => i.kind === "event")
      .map((i: { eventType: string }) => i.eventType);
    assert.ok(eventTypes.includes("agent_run_completed"));
    const messageItems = timeline.body.items.filter((i: { kind: string }) => i.kind === "message");
    assert.ok(messageItems.length >= 2);
  });

  it("executes: human takeover race -> marks agent run stale -> human manual reply with idempotency", async () => {
    // 1. Ensure conversation is under AI control
    const conv = await request(app)
      .get(`/v1/conversations/${conversationId}`)
      .set(authHeaders)
      .expect(200);
    let controlVersion = conv.body.controlVersion;
    if (conv.body.controlMode !== "ai") {
      const resumed = await request(app)
        .post(`/v1/conversations/${conversationId}/resume-ai`)
        .set(authHeaders)
        .send({ expectedControlVersion: controlVersion })
        .expect(200);
      controlVersion = resumed.body.controlVersion;
    }

    // 2. Customer inbound message
    await request(app)
      .post(`/v1/test/conversations/${conversationId}/inbound`)
      .set(authHeaders)
      .send({ eventId: randomUUID(), body: "أريد التحدث مع موظف خدمة عملاء الآن!" })
      .expect(201);

    // 3. Start slow agent turn
    const slowProvider = new SlowProvider();
    const agentPromise = runAgentTurn(pool, tenantId, conversationId, slowProvider);

    // 4. Concurrently, human agent takes over conversation
    const takeover = await request(app)
      .post(`/v1/conversations/${conversationId}/takeover`)
      .set(authHeaders)
      .send({ expectedControlVersion: controlVersion })
      .expect(200);
    assert.equal(takeover.body.controlMode, "human");
    const newControlVersion = takeover.body.controlVersion;

    // 5. Allow agent turn to complete
    slowProvider.release();
    const runResult = await agentPromise;

    // 6. Agent run must be marked stale; no agent message emitted!
    assert.equal(runResult.status, "stale");

    // 7. Human replies manually with Idempotency-Key
    const clientMessageId = randomUUID();
    const replyText = "مرحبًا بك، أنا مريم وسأساعدك مباشرة في حل المشكلة.";
    const manualReply = await request(app)
      .post(`/v1/conversations/${conversationId}/messages`)
      .set({ ...authHeaders, "Idempotency-Key": clientMessageId })
      .send({
        clientMessageId,
        expectedControlVersion: newControlVersion,
        body: replyText,
      })
      .expect(202);
    assert.equal(manualReply.body.message.senderType, "human");
    assert.equal(manualReply.body.message.body, replyText);

    // 8. Replay identical send -> returns duplicate without recreating
    const duplicateSend = await request(app)
      .post(`/v1/conversations/${conversationId}/messages`)
      .set({ ...authHeaders, "Idempotency-Key": clientMessageId })
      .send({
        clientMessageId,
        expectedControlVersion: newControlVersion,
        body: replyText,
      })
    assert.equal(duplicateSend.body.message.id, manualReply.body.message.id);
    assert.equal(duplicateSend.body.message.body, replyText);
  });

  it("executes: approval flow -> pending listed -> authorized decision -> approved_not_executed -> audit record", async () => {
    // 1. Put conversation back to AI mode
    const conv = await request(app)
      .get(`/v1/conversations/${conversationId}`)
      .set(authHeaders)
      .expect(200);
    await request(app)
      .post(`/v1/conversations/${conversationId}/resume-ai`)
      .set(authHeaders)
      .send({ expectedControlVersion: conv.body.controlVersion })
      .expect(200);

    // 2. Inbound message triggering refund approval
    await request(app)
      .post(`/v1/test/conversations/${conversationId}/inbound`)
      .set(authHeaders)
      .send({ eventId: randomUUID(), body: "أطلب استرداد مبلغ 150 ريال" })
      .expect(201);

    const approvalTurn = await runAgentTurn(
      pool,
      tenantId,
      conversationId,
      new RefundApprovalProvider(),
    );
    assert.equal(approvalTurn.decisionType, "request_approval");
    assert.ok(approvalTurn.approvalId);

    // 3. Approval listed under /v1/approvals
    const listRes = await request(app)
      .get(`/v1/approvals?conversationId=${conversationId}&status=pending`)
      .set(authHeaders)
      .expect(200);
    const item = listRes.body.items.find((i: { id: string }) => i.id === approvalTurn.approvalId);
    assert.ok(item);
    assert.equal(item.status, "pending");
    assert.equal(item.canDecide, true);
    assert.ok(item.actionHash);

    // 4. Authorized decision: approve
    const decisionKey = randomUUID();
    const decisionRes = await request(app)
      .post(`/v1/approvals/${item.id}/decision`)
      .set({ ...authHeaders, "Idempotency-Key": decisionKey })
      .send({
        decision: "approve",
        actionHash: item.actionHash,
      })
      .expect(200);
    assert.equal(decisionRes.body.status, "approved");
    assert.equal(decisionRes.body.executionStatus, "not_implemented");
    assert.equal(decisionRes.body.executed, false);

    // 5. Replay of decision is idempotent
    const replayRes = await request(app)
      .post(`/v1/approvals/${item.id}/decision`)
      .set({ ...authHeaders, "Idempotency-Key": decisionKey })
      .send({
        decision: "approve",
        actionHash: item.actionHash,
      })
      .expect(200);
    assert.equal(replayRes.body.duplicate, true);

    // 6. Task status confirmed updated in DB
    const taskRes = await request(app)
      .get(`/v1/tasks/${approvalTurn.taskId}`)
      .set(authHeaders)
      .expect(200);
    assert.equal(taskRes.body.status, "approved_not_executed");
  });

  it("executes: knowledge add -> search -> delete -> search after delete returns empty", async () => {
    const tempKey = `temp-know-${randomUUID()}`;
    const uniqueWord = `xyzretrieval${randomUUID().slice(0, 8)}`;

    // Add
    const created = await request(app)
      .post("/v1/knowledge/documents")
      .set(authHeaders)
      .send({
        sourceKey: tempKey,
        sourceName: "مستند مؤقت للاختبار",
        mediaType: "text/plain",
        content: `هذا مستند اختباري يحتوي على الكلمة السرية ${uniqueWord}.`,
      })
      .expect(201);

    // Search matches
    const searchMatch = await request(app)
      .get(`/v1/knowledge/search?q=${uniqueWord}`)
      .set(authHeaders)
      .expect(200);
    assert.ok(searchMatch.body.items.length >= 1);
    assert.ok(searchMatch.body.items[0].chunk.includes(uniqueWord));

    // Delete
    await request(app)
      .delete(`/v1/knowledge/documents/${created.body.id}`)
      .set(authHeaders)
      .expect(204);

    // Search returns 0 items for deleted document
    const searchAfter = await request(app)
      .get(`/v1/knowledge/search?q=${uniqueWord}`)
      .set(authHeaders)
      .expect(200);
    assert.equal(searchAfter.body.items.length, 0);
  });
});
