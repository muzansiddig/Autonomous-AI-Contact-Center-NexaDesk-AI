import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import pg from "pg";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  hashApprovalAction,
  runAgentTurn,
  type AgentContext,
  type AgentProvider,
} from "../src/agent-runtime.js";
import {
  ChannelDeliveryError,
  processOutboxBatch,
  TestOutboundAdapter,
  type OutboundMessage,
} from "../src/test-adapter.js";
import { TelegramOutboundAdapter } from "../src/telegram-adapter.js";

const config = loadConfig({
  ...process.env,
  NODE_ENV: "test",
  AGENT_PROVIDER: "fake",
});
if (!config.devAuthEnabled) {
  throw new Error("Integration tests require DEV_AUTH_ENABLED=true and a local development token.");
}

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const app = createApp(config, pool);
const telegramConfig = loadConfig({
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: config.databaseUrl,
  CHANNEL_ADAPTER: "telegram",
  TELEGRAM_BOT_TOKEN: "123456:mock-test-token",
  TELEGRAM_WEBHOOK_SECRET: "local-telegram-test-secret",
});
const telegramApp = createApp(telegramConfig, pool);
const authHeaders = { Authorization: `Bearer ${config.devAuthToken}` };
const channelId = randomUUID();
const contactId = randomUUID();
const conversationId = randomUUID();
const teamId = randomUUID();
const foreignTeamId = randomUUID();
const foreignTenantId = randomUUID();
const foreignChannelId = randomUUID();
const foreignContactId = randomUUID();
const foreignConversationId = randomUUID();
const foreignKnowledgeId = randomUUID();
const foreignTaskId = randomUUID();
const foreignApprovalId = randomUUID();
const telegramChannelId = randomUUID();
const knowledgeSourceKey = `integration-${randomUUID()}`;
let ready = false;

class RateLimitedOnceAdapter extends TestOutboundAdapter {
  private failed = false;

  override async send(message: OutboundMessage) {
    if (!this.failed) {
      this.failed = true;
      throw new ChannelDeliveryError("PROVIDER_RATE_LIMIT", true, true);
    }
    return super.send(message);
  }
}

class AmbiguousAdapter extends TestOutboundAdapter {
  override async send(
    _message: OutboundMessage,
  ): Promise<{ status: "accepted"; providerMessageId: string }> {
    throw new Error("simulated ambiguous provider timeout");
  }
}

class DeferredAgentProvider implements AgentProvider {
  readonly name = "fake";
  private signalStarted!: () => void;
  private finish!: (decision: unknown) => void;
  readonly started = new Promise<void>((resolve) => {
    this.signalStarted = resolve;
  });
  private readonly decision = new Promise<unknown>((resolve) => {
    this.finish = resolve;
  });

  async generate(_context: AgentContext, signal: AbortSignal): Promise<unknown> {
    this.signalStarted();
    if (signal.aborted) throw new Error("cancelled");
    return this.decision;
  }

  complete(decision: unknown): void {
    this.finish(decision);
  }
}

class ApprovalAgentProvider implements AgentProvider {
  readonly name = "fake";

  async generate(_context: AgentContext, _signal: AbortSignal): Promise<unknown> {
    return {
      type: "request_approval",
      action: { type: "refund", orderReference: "ORDER-TEST-1", amount: 75 },
      usage: { promptTokens: 12, completionTokens: 8 },
    };
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
      [config.devTenantId, channelId, `integration-${channelId}`],
    );
    await client.query(
      `INSERT INTO channel_connections
         (tenant_id, id, channel_type, external_account_id, configuration_status, capabilities)
       VALUES ($1, $2, 'telegram', 'mock-test-bot', 'ready',
               '{"text":true,"inboundWebhooks":true,"deliveryReceipts":false,"providerIdempotency":false}'::jsonb)`,
      [config.devTenantId, telegramChannelId],
    );
    await client.query(
      "INSERT INTO contacts (tenant_id, id, display_name) VALUES ($1, $2, 'Integration Test Contact')",
      [config.devTenantId, contactId],
    );
    await client.query(
      "INSERT INTO teams (tenant_id, id, name) VALUES ($1, $2, 'Integration Team')",
      [config.devTenantId, teamId],
    );
    await client.query(
      `INSERT INTO conversations
         (tenant_id, id, contact_id, channel_connection_id, control_mode, control_version, subject, unread_count)
       VALUES ($1, $2, $3, $4, 'ai', 0, 'API integration test', 1)`,
      [config.devTenantId, conversationId, contactId, channelId],
    );
    await client.query(
      "INSERT INTO tenants (id, name) VALUES ($1, 'Isolated Integration Tenant')",
      [foreignTenantId],
    );
    await client.query(
      "INSERT INTO teams (tenant_id, id, name) VALUES ($1, $2, 'Foreign Integration Team')",
      [foreignTenantId, foreignTeamId],
    );
    await client.query(
      `INSERT INTO channel_connections
         (tenant_id, id, channel_type, external_account_id, configuration_status, capabilities)
       VALUES ($1, $2, 'web', $3, 'ready', '{"text":true,"providerIdempotency":true}'::jsonb)`,
      [foreignTenantId, foreignChannelId, `integration-${foreignChannelId}`],
    );
    await client.query(
      "INSERT INTO contacts (tenant_id, id, display_name) VALUES ($1, $2, 'Foreign Integration Contact')",
      [foreignTenantId, foreignContactId],
    );
    await client.query(
      `INSERT INTO conversations
         (tenant_id, id, contact_id, channel_connection_id, control_mode, control_version, subject)
       VALUES ($1, $2, $3, $4, 'ai', 0, 'Foreign tenant fixture')`,
      [foreignTenantId, foreignConversationId, foreignContactId, foreignChannelId],
    );
    await client.query(
      `INSERT INTO knowledge_documents
         (tenant_id, id, source_key, source_name, version, content_sha256, media_type, status)
       VALUES ($1, $2, 'foreign-source', 'Foreign confidential doc', 1, 'foreign-hash', 'text/plain', 'active')`,
      [foreignTenantId, foreignKnowledgeId],
    );
    await client.query(
      `INSERT INTO knowledge_chunks (tenant_id, document_id, document_version, ordinal, content)
       VALUES ($1, $2, 1, 0, 'foreign-private-marker')`,
      [foreignTenantId, foreignKnowledgeId],
    );
    await client.query(
      `INSERT INTO tasks (tenant_id, id, conversation_id, task_type, status)
       VALUES ($1, $2, $3, 'refund', 'waiting_approval')`,
      [foreignTenantId, foreignTaskId, foreignConversationId],
    );
    await client.query(
      `INSERT INTO approval_requests
         (tenant_id, id, task_id, requested_action, action_hash)
       VALUES ($1, $2, $3, '{"type":"refund","orderReference":"FOREIGN"}'::jsonb, 'foreign-hash')`,
      [foreignTenantId, foreignApprovalId, foreignTaskId],
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
      await client.query(
        "DELETE FROM outbox_events WHERE tenant_id = $1 AND aggregate_id = $2",
        [config.devTenantId, conversationId],
      );
      await client.query(
        `DELETE FROM outbox_events
         WHERE tenant_id = $1 AND aggregate_id IN (
           SELECT id FROM conversations WHERE tenant_id = $1 AND channel_connection_id = $2
         )`,
        [config.devTenantId, telegramChannelId],
      );
      await client.query(
        "DELETE FROM knowledge_documents WHERE tenant_id = $1 AND source_key = $2",
        [config.devTenantId, knowledgeSourceKey],
      );
      await client.query(
        `UPDATE tenant_agent_settings
         SET enabled = false, provider = 'disabled', system_instructions = ''
         WHERE tenant_id = $1`,
        [config.devTenantId],
      );
      await client.query(
        "DELETE FROM conversation_events WHERE tenant_id = $1 AND conversation_id = $2",
        [config.devTenantId, conversationId],
      );
      await client.query(
        "DELETE FROM conversation_messages WHERE tenant_id = $1 AND conversation_id = $2",
        [config.devTenantId, conversationId],
      );
      await client.query(
        `DELETE FROM approval_requests
         WHERE tenant_id = $1
           AND task_id IN (
             SELECT id FROM tasks WHERE tenant_id = $1 AND conversation_id = $2
           )`,
        [config.devTenantId, conversationId],
      );
      await client.query(
        "DELETE FROM tasks WHERE tenant_id = $1 AND conversation_id = $2",
        [config.devTenantId, conversationId],
      );
      await client.query(
        `DELETE FROM conversation_events WHERE tenant_id = $1 AND conversation_id IN (
           SELECT id FROM conversations WHERE tenant_id = $1 AND channel_connection_id = $2
         )`,
        [config.devTenantId, telegramChannelId],
      );
      await client.query(
        `DELETE FROM conversation_messages WHERE tenant_id = $1 AND conversation_id IN (
           SELECT id FROM conversations WHERE tenant_id = $1 AND channel_connection_id = $2
         )`,
        [config.devTenantId, telegramChannelId],
      );
      await client.query(
        "DELETE FROM channel_webhook_events WHERE tenant_id = $1 AND channel_connection_id = $2",
        [config.devTenantId, telegramChannelId],
      );
      await client.query(
        "DELETE FROM conversations WHERE tenant_id = $1 AND channel_connection_id = $2",
        [config.devTenantId, telegramChannelId],
      );
      await client.query(
        "DELETE FROM contacts WHERE tenant_id = $1 AND channel_connection_id = $2",
        [config.devTenantId, telegramChannelId],
      );
      await client.query(
        "DELETE FROM channel_connections WHERE tenant_id = $1 AND id = $2",
        [config.devTenantId, telegramChannelId],
      );
      await client.query(
        "DELETE FROM users WHERE identity_issuer LIKE 'http://127.0.0.1:%/oidc-test/'",
      );
      await client.query(
        "DELETE FROM conversations WHERE tenant_id = $1 AND id = $2",
        [config.devTenantId, conversationId],
      );
      await client.query(
        "DELETE FROM contacts WHERE tenant_id = $1 AND id = $2",
        [config.devTenantId, contactId],
      );
      await client.query(
        "DELETE FROM teams WHERE tenant_id = $1 AND id = $2",
        [config.devTenantId, teamId],
      );
      await client.query(
        "DELETE FROM conversation_events WHERE tenant_id = $1 AND conversation_id = $2",
        [foreignTenantId, foreignConversationId],
      );
      await client.query(
        "DELETE FROM approval_requests WHERE tenant_id = $1 AND id = $2",
        [foreignTenantId, foreignApprovalId],
      );
      await client.query(
        "DELETE FROM tasks WHERE tenant_id = $1 AND id = $2",
        [foreignTenantId, foreignTaskId],
      );
      await client.query(
        "DELETE FROM conversations WHERE tenant_id = $1 AND id = $2",
        [foreignTenantId, foreignConversationId],
      );
      await client.query(
        "DELETE FROM contacts WHERE tenant_id = $1 AND id = $2",
        [foreignTenantId, foreignContactId],
      );
      await client.query(
        "DELETE FROM teams WHERE tenant_id = $1 AND id = $2",
        [foreignTenantId, foreignTeamId],
      );
      await client.query(
        "DELETE FROM channel_connections WHERE tenant_id = $1 AND id = $2",
        [foreignTenantId, foreignChannelId],
      );
      await client.query("DELETE FROM tenants WHERE id = $1", [foreignTenantId]);
      await client.query(
        "DELETE FROM channel_connections WHERE tenant_id = $1 AND id = $2",
        [config.devTenantId, channelId],
      );
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

describe("PostgreSQL conversation and control integration", () => {
  it("rejects expired and wrong-audience OIDC tokens and enforces active membership", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const kid = `test-${randomUUID()}`;
    const jwk = await exportJWK(publicKey);
    jwk.kid = kid;
    jwk.alg = "RS256";
    jwk.use = "sig";
    const jwksServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
    const address = jwksServer.address();
    if (!address || typeof address === "string") throw new Error("The test JWKS server did not bind.");
    const issuer = `http://127.0.0.1:${address.port}/oidc-test/`;
    const audience = "nexadesk-integration-api";
    const oidcConfig = loadConfig({
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: config.databaseUrl,
      DEV_AUTH_ENABLED: "false",
      AUTH_ISSUER: issuer,
      AUTH_AUDIENCE: audience,
      AUTH_JWKS_URL: `${issuer}.well-known/jwks.json`,
      AGENT_PROVIDER: "disabled",
    });
    const oidcApp = createApp(oidcConfig, pool);
    const userId = randomUUID();
    const noMembershipUserId = randomUUID();
    const revokedUserId = randomUUID();
    const roleTestTaskId = randomUUID();
    const roleTestApprovalId = randomUUID();
    const subject = `oidc-${randomUUID()}`;
    const noMembershipSubject = `no-membership-${randomUUID()}`;
    const revokedSubject = `revoked-${randomUUID()}`;
    try {
      await pool.query(
        `INSERT INTO users (id, identity_issuer, identity_subject, display_name)
         VALUES ($1, $2, $3, 'OIDC Integration User'),
                ($4, $2, $5, 'OIDC No Membership'),
                ($6, $2, $7, 'OIDC Revoked Membership')`,
        [userId, issuer, subject, noMembershipUserId, noMembershipSubject, revokedUserId, revokedSubject],
      );
      await pool.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role, status)
         VALUES ($1, $2, 'agent', 'active'), ($1, $3, 'agent', 'revoked')`,
        [config.devTenantId, userId, revokedUserId],
      );
      const roleTestAction = { type: "cancel_order" as const, orderReference: "ROLE-TEST-1" };
      await pool.query(
        `INSERT INTO tasks (tenant_id, id, conversation_id, task_type, status)
         VALUES ($1, $2, $3, 'approval:cancel_order', 'waiting_approval')`,
        [config.devTenantId, roleTestTaskId, conversationId],
      );
      await pool.query(
        `INSERT INTO approval_requests
           (tenant_id, id, task_id, requested_action, action_hash, control_version)
         VALUES ($1, $2, $3, $4::jsonb, $5, 0)`,
        [
          config.devTenantId,
          roleTestApprovalId,
          roleTestTaskId,
          JSON.stringify(roleTestAction),
          hashApprovalAction(roleTestAction),
        ],
      );
      const tokenFor = (tokenSubject: string, tokenAudience: string, expiresAt: number) =>
        new SignJWT({})
          .setProtectedHeader({ alg: "RS256", kid })
          .setIssuer(issuer)
          .setAudience(tokenAudience)
          .setSubject(tokenSubject)
          .setExpirationTime(expiresAt)
          .sign(privateKey);
      const now = Math.floor(Date.now() / 1_000);
      const validToken = await tokenFor(subject, audience, now + 60);
      await request(oidcApp)
        .get(`/v1/conversations/${conversationId}`)
        .set("Authorization", `Bearer ${validToken}`)
        .expect(200);
      const agentApprovals = await request(oidcApp)
        .get(`/v1/approvals?conversationId=${conversationId}&status=pending`)
        .set("Authorization", `Bearer ${validToken}`)
        .expect(200);
      const roleApproval = agentApprovals.body.items.find(
        (item: { id: string }) => item.id === roleTestApprovalId,
      );
      assert.equal(roleApproval.canDecide, false);
      await request(oidcApp)
        .post(`/v1/approvals/${roleTestApprovalId}/decision`)
        .set({ Authorization: `Bearer ${validToken}`, "Idempotency-Key": randomUUID() })
        .send({ decision: "approve", actionHash: hashApprovalAction(roleTestAction) })
        .expect(403);
      const roleApprovalState = await pool.query<{ status: string }>(
        "SELECT status FROM approval_requests WHERE tenant_id = $1 AND id = $2",
        [config.devTenantId, roleTestApprovalId],
      );
      assert.equal(roleApprovalState.rows[0].status, "pending");
      await request(oidcApp)
        .get(`/v1/conversations/${conversationId}`)
        .set({
          Authorization: `Bearer ${validToken}`,
          "X-Tenant-Id": foreignTenantId,
        })
        .expect(403);

      const wrongAudience = await tokenFor(subject, "another-api", now + 60);
      await request(oidcApp)
        .get("/v1/conversations")
        .set("Authorization", `Bearer ${wrongAudience}`)
        .expect(401);
      const expiredToken = await tokenFor(subject, audience, now - 60);
      const expiredResponse = await request(oidcApp)
        .get("/v1/conversations")
        .set("Authorization", `Bearer ${expiredToken}`)
        .expect(401);
      assert.equal(expiredResponse.body.error.code, "TOKEN_EXPIRED");

      const noMembershipToken = await tokenFor(noMembershipSubject, audience, now + 60);
      await request(oidcApp)
        .get("/v1/conversations")
        .set("Authorization", `Bearer ${noMembershipToken}`)
        .expect(403);
      const revokedToken = await tokenFor(revokedSubject, audience, now + 60);
      await request(oidcApp)
        .get("/v1/conversations")
        .set("Authorization", `Bearer ${revokedToken}`)
        .expect(403);
      await request(oidcApp)
        .get("/v1/conversations")
        .set("Authorization", "Bearer not-a-jwt")
        .expect(401);
    } finally {
      await pool.query(
        "DELETE FROM approval_requests WHERE tenant_id = $1 AND id = $2",
        [config.devTenantId, roleTestApprovalId],
      );
      await pool.query(
        "DELETE FROM tasks WHERE tenant_id = $1 AND id = $2",
        [config.devTenantId, roleTestTaskId],
      );
      await pool.query(
        `DELETE FROM tenant_memberships
         WHERE user_id = ANY($1::uuid[])`,
        [[userId, noMembershipUserId, revokedUserId]],
      );
      await pool.query(
        `DELETE FROM users WHERE id = ANY($1::uuid[])`,
        [[userId, noMembershipUserId, revokedUserId]],
      );
      await new Promise<void>((resolve, reject) => {
        jwksServer.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("rejects stale sends, deduplicates replies, and invalidates queued sends on takeover", async () => {
    const list = await request(app)
      .get("/v1/conversations?query=Integration&limit=10")
      .set(authHeaders)
      .expect(200);
    assert.ok(list.body.items.some((item: { id: string }) => item.id === conversationId));

    const detail = await request(app)
      .get(`/v1/conversations/${conversationId}`)
      .set(authHeaders)
      .expect(200);
    assert.equal(detail.body.controlMode, "ai");
    assert.equal(detail.body.controlVersion, 0);

    const takeover = await request(app)
      .post(`/v1/conversations/${conversationId}/takeover`)
      .set(authHeaders)
      .send({ expectedControlVersion: 0 })
      .expect(200);
    assert.equal(takeover.body.controlMode, "human");
    assert.equal(takeover.body.controlVersion, 1);

    const staleControl = await request(app)
      .post(`/v1/conversations/${conversationId}/pause-ai`)
      .set(authHeaders)
      .send({ expectedControlVersion: 0 })
      .expect(409);
    assert.equal(staleControl.body.error.code, "STALE_CONTROL_VERSION");

    const staleSendId = randomUUID();
    const staleSend = await request(app)
      .post(`/v1/conversations/${conversationId}/messages`)
      .set({ ...authHeaders, "Idempotency-Key": staleSendId })
      .send({
        clientMessageId: staleSendId,
        expectedControlVersion: 0,
        body: "stale reply",
      })
      .expect(409);
    assert.equal(staleSend.body.error.code, "STALE_CONTROL_VERSION");

    const messageId = randomUUID();
    const messageBody = {
      clientMessageId: messageId,
      expectedControlVersion: 1,
      body: "test adapter reply",
    };
    const firstSend = await request(app)
      .post(`/v1/conversations/${conversationId}/messages`)
      .set({ ...authHeaders, "Idempotency-Key": messageId })
      .send(messageBody)
      .expect(202);
    const duplicateSend = await request(app)
      .post(`/v1/conversations/${conversationId}/messages`)
      .set({ ...authHeaders, "Idempotency-Key": messageId })
      .send(messageBody)
      .expect(202);
    assert.equal(firstSend.body.message.id, duplicateSend.body.message.id);

    await processOutboxBatch(pool, new TestOutboundAdapter());
    const accepted = await request(app)
      .get(`/v1/messages/${firstSend.body.message.id}`)
      .set(authHeaders)
      .expect(200);
    assert.equal(accepted.body.deliveryStatus, "accepted");

    const retryMessageId = randomUUID();
    const retrySend = await request(app)
      .post(`/v1/conversations/${conversationId}/messages`)
      .set({ ...authHeaders, "Idempotency-Key": retryMessageId })
      .send({
        clientMessageId: retryMessageId,
        expectedControlVersion: 1,
        body: "retry after a safe rate limit",
      })
      .expect(202);
    const retryAdapter = new RateLimitedOnceAdapter();
    await processOutboxBatch(pool, retryAdapter);
    const retryScheduled = await request(app)
      .get(`/v1/messages/${retrySend.body.message.id}`)
      .set(authHeaders)
      .expect(200);
    assert.equal(retryScheduled.body.deliveryStatus, "queued");
    await pool.query(
      `UPDATE outbox_events SET available_at = now() - interval '1 second'
       WHERE tenant_id = $1 AND payload->>'messageId' = $2 AND status = 'pending'`,
      [config.devTenantId, retrySend.body.message.id],
    );
    await processOutboxBatch(pool, retryAdapter);
    const retryAccepted = await request(app)
      .get(`/v1/messages/${retrySend.body.message.id}`)
      .set(authHeaders)
      .expect(200);
    assert.equal(retryAccepted.body.deliveryStatus, "accepted");

    const ambiguousMessageId = randomUUID();
    const ambiguousSend = await request(app)
      .post(`/v1/conversations/${conversationId}/messages`)
      .set({ ...authHeaders, "Idempotency-Key": ambiguousMessageId })
      .send({
        clientMessageId: ambiguousMessageId,
        expectedControlVersion: 1,
        body: "ambiguous result must not retry",
      })
      .expect(202);
    await processOutboxBatch(pool, new AmbiguousAdapter());
    const ambiguousStatus = await request(app)
      .get(`/v1/messages/${ambiguousSend.body.message.id}`)
      .set(authHeaders)
      .expect(200);
    assert.equal(ambiguousStatus.body.deliveryStatus, "unknown");

    const expiredLeaseId = randomUUID();
    const expiredLeaseSend = await request(app)
      .post(`/v1/conversations/${conversationId}/messages`)
      .set({ ...authHeaders, "Idempotency-Key": expiredLeaseId })
      .send({
        clientMessageId: expiredLeaseId,
        expectedControlVersion: 1,
        body: "expired worker lease must not trigger a resend",
      })
      .expect(202);
    await pool.query(
      `UPDATE outbox_events
       SET status = 'processing', attempts = 1, lease_owner = 'expired-worker',
           lease_expires_at = now() - interval '1 second'
       WHERE tenant_id = $1 AND payload->>'messageId' = $2`,
      [config.devTenantId, expiredLeaseSend.body.message.id],
    );
    const expiredLeaseAdapter = new TestOutboundAdapter();
    await processOutboxBatch(pool, expiredLeaseAdapter);
    const expiredLeaseStatus = await request(app)
      .get(`/v1/messages/${expiredLeaseSend.body.message.id}`)
      .set(authHeaders)
      .expect(200);
    assert.equal(expiredLeaseStatus.body.deliveryStatus, "unknown");
    const expiredLeaseOutbox = await pool.query<{
      status: string;
      attempts: number;
      last_error_code: string;
    }>(
      `SELECT status, attempts, last_error_code FROM outbox_events
       WHERE tenant_id = $1 AND payload->>'messageId' = $2`,
      [config.devTenantId, expiredLeaseSend.body.message.id],
    );
    assert.equal(expiredLeaseOutbox.rows[0].status, "unknown");
    assert.equal(expiredLeaseOutbox.rows[0].attempts, 1);
    assert.equal(expiredLeaseOutbox.rows[0].last_error_code, "WORKER_LEASE_EXPIRED");

    const queuedBeforeResumeId = randomUUID();
    const queuedBeforeResume = await request(app)
      .post(`/v1/conversations/${conversationId}/messages`)
      .set({ ...authHeaders, "Idempotency-Key": queuedBeforeResumeId })
      .send({
        clientMessageId: queuedBeforeResumeId,
        expectedControlVersion: 1,
        body: "must not leave after resume",
      })
      .expect(202);
    const resumed = await request(app)
      .post(`/v1/conversations/${conversationId}/resume-ai`)
      .set(authHeaders)
      .send({ expectedControlVersion: 1 })
      .expect(200);
    assert.equal(resumed.body.controlVersion, 2);

    await processOutboxBatch(pool, new TestOutboundAdapter());
    const rejected = await request(app)
      .get(`/v1/messages/${queuedBeforeResume.body.message.id}`)
      .set(authHeaders)
      .expect(200);
    assert.equal(rejected.body.deliveryStatus, "failed");

    const simultaneous = await Promise.all([
      request(app)
        .post(`/v1/conversations/${conversationId}/takeover`)
        .set(authHeaders)
        .send({ expectedControlVersion: 2 }),
      request(app)
        .post(`/v1/conversations/${conversationId}/pause-ai`)
        .set(authHeaders)
        .send({ expectedControlVersion: 2 }),
    ]);
    assert.deepEqual(
      simultaneous.map((response) => response.status).sort(),
      [200, 409],
    );

    const assignment = await request(app)
      .post(`/v1/conversations/${conversationId}/assign`)
      .set(authHeaders)
      .send({ expectedControlVersion: 3, teamId: foreignTeamId })
      .expect(422);
    assert.equal(assignment.body.error.code, "INVALID_TEAM");

    const validAssignment = await request(app)
      .post(`/v1/conversations/${conversationId}/assign`)
      .set(authHeaders)
      .send({ expectedControlVersion: 3, teamId })
      .expect(200);
    assert.equal(validAssignment.body.controlVersion, 4);
    const assignedConversation = await request(app)
      .get(`/v1/conversations/${conversationId}`)
      .set(authHeaders)
      .expect(200);
    assert.equal(assignedConversation.body.assignee.teamId, teamId);

    const timeline = await request(app)
      .get(`/v1/conversations/${conversationId}/timeline?limit=20`)
      .set(authHeaders)
      .expect(200);
    assert.ok(timeline.body.items.some((item: { kind: string }) => item.kind === "event"));

    const markedRead = await request(app)
      .post(`/v1/conversations/${conversationId}/read`)
      .set(authHeaders)
      .send({})
      .expect(200);
    assert.equal(markedRead.body.unreadCount, 0);
  });

  it("verifies and deduplicates Telegram webhooks, then delivers through a mocked Telegram API", async () => {
    const update = {
      update_id: 8_700_001,
      message: {
        message_id: 31,
        chat: { id: 771_234_567, type: "private" },
        from: { id: 771_234_567, first_name: "Telegram Test User" },
        text: "I need help with my order",
      },
    };
    await request(telegramApp)
      .post(`/webhooks/telegram/${telegramChannelId}`)
      .set("X-Telegram-Bot-Api-Secret-Token", "incorrect-secret")
      .send(update)
      .expect(401);

    const inbound = await request(telegramApp)
      .post(`/webhooks/telegram/${telegramChannelId}`)
      .set("X-Telegram-Bot-Api-Secret-Token", "local-telegram-test-secret")
      .send(update)
      .expect(201);
    assert.equal(typeof inbound.body.conversationId, "string");
    assert.equal(typeof inbound.body.messageId, "string");
    const duplicate = await request(telegramApp)
      .post(`/webhooks/telegram/${telegramChannelId}`)
      .set("X-Telegram-Bot-Api-Secret-Token", "local-telegram-test-secret")
      .send(update)
      .expect(200);
    assert.equal(duplicate.body.duplicate, true);
    const inboundCounts = await pool.query<{ message_count: string; event_count: string }>(
      `SELECT
         (SELECT count(*) FROM conversation_messages
          WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'inbound')::text AS message_count,
         (SELECT count(*) FROM channel_webhook_events
          WHERE tenant_id = $1 AND channel_connection_id = $3
            AND provider_event_id = $4 AND status = 'processed')::text AS event_count`,
      [config.devTenantId, inbound.body.conversationId, telegramChannelId, String(update.update_id)],
    );
    assert.equal(inboundCounts.rows[0].message_count, "1");
    assert.equal(inboundCounts.rows[0].event_count, "1");

    await request(app)
      .post(`/v1/conversations/${inbound.body.conversationId}/takeover`)
      .set(authHeaders)
      .send({ expectedControlVersion: 0 })
      .expect(200);
    const clientMessageId = randomUUID();
    const send = await request(app)
      .post(`/v1/conversations/${inbound.body.conversationId}/messages`)
      .set({ ...authHeaders, "Idempotency-Key": clientMessageId })
      .send({
        clientMessageId,
        expectedControlVersion: 1,
        body: "The mock adapter confirms this message was accepted.",
      })
      .expect(202);

    let sendAttempts = 0;
    let requestDestination = "";
    const telegramAdapter = new TelegramOutboundAdapter({
      botToken: "123456:mock-test-token",
      fetchImpl: async (_input, init) => {
        sendAttempts += 1;
        const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string };
        requestDestination = body.chat_id;
        if (sendAttempts === 1) {
          return new Response(JSON.stringify({
            ok: false,
            error_code: 429,
            parameters: { retry_after: 1 },
          }), { status: 429 });
        }
        return new Response(JSON.stringify({
          ok: true,
          result: { message_id: 32 },
        }), { status: 200 });
      },
    });
    await processOutboxBatch(pool, telegramAdapter);
    const rateLimited = await request(app)
      .get(`/v1/messages/${send.body.message.id}`)
      .set(authHeaders)
      .expect(200);
    assert.equal(rateLimited.body.deliveryStatus, "queued");
    await pool.query(
      `UPDATE outbox_events SET available_at = now() - interval '1 second'
       WHERE tenant_id = $1 AND payload->>'messageId' = $2 AND status = 'pending'`,
      [config.devTenantId, send.body.message.id],
    );
    await processOutboxBatch(pool, telegramAdapter);
    const accepted = await request(app)
      .get(`/v1/messages/${send.body.message.id}`)
      .set(authHeaders)
      .expect(200);
    assert.equal(accepted.body.deliveryStatus, "accepted");
    assert.equal(requestDestination, "771234567");
    assert.equal(sendAttempts, 2);
  });

  it("does not reveal another tenant's conversation", async () => {
    const response = await request(app)
      .get(`/v1/conversations/${foreignConversationId}`)
      .set(authHeaders)
      .expect(404);
    assert.equal(response.body.error.code, "CONVERSATION_NOT_FOUND");

    const list = await request(app)
      .get("/v1/conversations?limit=100")
      .set(authHeaders)
      .expect(200);
    assert.equal(
      list.body.items.some((item: { id: string }) => item.id === foreignConversationId),
      false,
    );

    const takeover = await request(app)
      .post(`/v1/conversations/${foreignConversationId}/takeover`)
      .set(authHeaders)
      .send({ expectedControlVersion: 0 })
      .expect(404);
    assert.equal(takeover.body.error.code, "CONVERSATION_NOT_FOUND");

    const teams = await request(app)
      .get("/v1/teams")
      .set(authHeaders)
      .expect(200);
    assert.equal(teams.body.some((team: { id: string }) => team.id === foreignTeamId), false);

    const channels = await request(app)
      .get("/v1/channels")
      .set(authHeaders)
      .expect(200);
    assert.equal(channels.body.some((channel: { id: string }) => channel.id === foreignChannelId), false);

    const knowledge = await request(app)
      .get("/v1/knowledge/documents")
      .set(authHeaders)
      .expect(200);
    assert.equal(knowledge.body.some((document: { id: string }) => document.id === foreignKnowledgeId), false);

    const tasks = await request(app)
      .get("/v1/tasks")
      .set(authHeaders)
      .expect(200);
    assert.equal(tasks.body.items.some((task: { id: string }) => task.id === foreignTaskId), false);
    await request(app)
      .get(`/v1/tasks/${foreignTaskId}`)
      .set(authHeaders)
      .expect(404);

    const approvals = await request(app)
      .get("/v1/approvals")
      .set(authHeaders)
      .expect(200);
    assert.equal(approvals.body.items.some((approval: { id: string }) => approval.id === foreignApprovalId), false);
    await request(app)
      .post(`/v1/approvals/${foreignApprovalId}/decision`)
      .set({ ...authHeaders, "Idempotency-Key": randomUUID() })
      .send({ decision: "approve", actionHash: "a".repeat(64) })
      .expect(404);
  });

  it("registers, replaces, searches and deletes only tenant knowledge", async () => {
    const first = await request(app)
      .post("/v1/knowledge/documents")
      .set(authHeaders)
      .send({
        sourceKey: knowledgeSourceKey,
        sourceName: "Integration Policy",
        mediaType: "text/plain",
        content: "Return policy allows exchanges within fourteen days.",
      })
      .expect(201);
    assert.equal(first.body.version, 1);
    assert.equal(first.body.status, "active");

    const foreign = await request(app)
      .get("/v1/knowledge/search?q=foreign-private-marker")
      .set(authHeaders)
      .expect(200);
    assert.equal(foreign.body.items.length, 0);

    const replaced = await request(app)
      .post("/v1/knowledge/documents")
      .set(authHeaders)
      .send({
        sourceKey: knowledgeSourceKey,
        sourceName: "Integration Policy",
        mediaType: "text/markdown",
        content: "Refund policy allows refunds within seven days.",
      })
      .expect(201);
    assert.equal(replaced.body.version, 2);

    const oldVersion = await request(app)
      .get("/v1/knowledge/search?q=exchanges")
      .set(authHeaders)
      .expect(200);
    assert.equal(oldVersion.body.items.length, 0);

    const currentVersion = await request(app)
      .get("/v1/knowledge/search?q=refund")
      .set(authHeaders)
      .expect(200);
    assert.equal(currentVersion.body.items[0].documentId, replaced.body.id);

    await request(app)
      .delete(`/v1/knowledge/documents/${replaced.body.id}`)
      .set(authHeaders)
      .expect(204);
    const deletedVersion = await request(app)
      .get("/v1/knowledge/search?q=refund")
      .set(authHeaders)
      .expect(200);
    assert.equal(deletedVersion.body.items.length, 0);
    await pool.query(
      "DELETE FROM knowledge_documents WHERE tenant_id = $1 AND source_key = $2",
      [config.devTenantId, knowledgeSourceKey],
    );
  });

  it("deduplicates simulated inbound events and runs the fake agent with control revalidation", async () => {
    const settings = await request(app)
      .put("/v1/agent/settings")
      .set(authHeaders)
      .send({ enabled: true, provider: "fake", systemInstructions: "Test instructions." })
      .expect(200);
    assert.equal(settings.body.enabled, true);

    let detail = await request(app)
      .get(`/v1/conversations/${conversationId}`)
      .set(authHeaders)
      .expect(200);
    if (detail.body.controlMode !== "ai") {
      const resumed = await request(app)
        .post(`/v1/conversations/${conversationId}/resume-ai`)
        .set(authHeaders)
        .send({ expectedControlVersion: detail.body.controlVersion })
        .expect(200);
      detail.body.controlVersion = resumed.body.controlVersion;
    }

    const inboundEventId = randomUUID();
    const inboundPayload = { eventId: inboundEventId, body: "أحتاج توضيحًا بخصوص طلبي" };
    const inbound = await request(app)
      .post(`/v1/test/conversations/${conversationId}/inbound`)
      .set(authHeaders)
      .send(inboundPayload)
      .expect(201);
    const duplicateInbound = await request(app)
      .post(`/v1/test/conversations/${conversationId}/inbound`)
      .set(authHeaders)
      .send(inboundPayload)
      .expect(200);
    assert.equal(duplicateInbound.body.id, inbound.body.id);
    assert.equal(duplicateInbound.body.duplicate, true);

    const run = await request(app)
      .post(`/v1/conversations/${conversationId}/agent-runs`)
      .set(authHeaders)
      .send({})
      .expect(202);
    assert.equal(run.body.status, "completed");
    assert.equal(run.body.decisionType, "clarify");
    assert.ok(run.body.messageId);

    const duplicateRun = await request(app)
      .post(`/v1/conversations/${conversationId}/agent-runs`)
      .set(authHeaders)
      .send({})
      .expect(202);
    assert.equal(duplicateRun.body.runId, run.body.runId);

    await processOutboxBatch(pool, new TestOutboundAdapter());
    const generatedMessage = await request(app)
      .get(`/v1/messages/${run.body.messageId}`)
      .set(authHeaders)
      .expect(200);
    assert.equal(generatedMessage.body.senderType, "agent");
    assert.equal(generatedMessage.body.deliveryStatus, "accepted");

    await request(app)
      .post(`/v1/test/conversations/${conversationId}/inbound`)
      .set(authHeaders)
      .send({ eventId: randomUUID(), body: "أحتاج استرداد مبلغ" })
      .expect(201);
    const approvalRun = await runAgentTurn(
      pool,
      config.devTenantId,
      conversationId,
      new ApprovalAgentProvider(),
    );
    assert.equal(approvalRun.decisionType, "request_approval");
    assert.ok(approvalRun.approvalId);
    const approvals = await request(app)
      .get(`/v1/approvals?conversationId=${conversationId}&status=pending`)
      .set(authHeaders)
      .expect(200);
    const approval = approvals.body.items.find(
      (item: { id: string }) => item.id === approvalRun.approvalId,
    );
    assert.ok(approval.actionHash);
    const decisionIdempotencyKey = randomUUID();

    await pool.query(
      `UPDATE approval_requests SET requested_action = $3::jsonb
       WHERE tenant_id = $1 AND id = $2`,
      [
        config.devTenantId,
        approvalRun.approvalId,
        JSON.stringify({ type: "refund", orderReference: "TAMPERED", amount: 75 }),
      ],
    );
    const tamperedApproval = await request(app)
      .post(`/v1/approvals/${approvalRun.approvalId}/decision`)
      .set({ ...authHeaders, "Idempotency-Key": decisionIdempotencyKey })
      .send({ decision: "approve", actionHash: approval.actionHash })
      .expect(409);
    assert.equal(tamperedApproval.body.error.code, "APPROVAL_ACTION_TAMPERED");
    await pool.query(
      `UPDATE approval_requests SET requested_action = $3::jsonb
       WHERE tenant_id = $1 AND id = $2`,
      [
        config.devTenantId,
        approvalRun.approvalId,
        JSON.stringify({ type: "refund", orderReference: "ORDER-TEST-1", amount: 75 }),
      ],
    );
    const approved = await request(app)
      .post(`/v1/approvals/${approvalRun.approvalId}/decision`)
      .set({ ...authHeaders, "Idempotency-Key": decisionIdempotencyKey })
      .send({ decision: "approve", actionHash: approval.actionHash })
      .expect(200);
    assert.equal(approved.body.status, "approved");
    assert.equal(approved.body.executionStatus, "not_implemented");
    assert.equal(approved.body.executed, false);
    const replay = await request(app)
      .post(`/v1/approvals/${approvalRun.approvalId}/decision`)
      .set({ ...authHeaders, "Idempotency-Key": decisionIdempotencyKey })
      .send({ decision: "approve", actionHash: approval.actionHash })
      .expect(200);
    assert.equal(replay.body.duplicate, true);
    const replayWithDifferentDecision = await request(app)
      .post(`/v1/approvals/${approvalRun.approvalId}/decision`)
      .set({ ...authHeaders, "Idempotency-Key": decisionIdempotencyKey })
      .send({ decision: "reject", actionHash: approval.actionHash })
      .expect(409);
    assert.equal(replayWithDifferentDecision.body.error.code, "IDEMPOTENCY_KEY_REUSED");
    const approvedTask = await request(app)
      .get(`/v1/tasks/${approvalRun.taskId}`)
      .set(authHeaders)
      .expect(200);
    assert.equal(approvedTask.body.status, "approved_not_executed");
    const missingDecisionKey = await request(app)
      .post(`/v1/approvals/${approvalRun.approvalId}/decision`)
      .set(authHeaders)
      .send({ decision: "approve", actionHash: approval.actionHash })
      .expect(400);
    assert.equal(missingDecisionKey.body.error.code, "INVALID_REQUEST");

    const rejectTaskId = randomUUID();
    const rejectApprovalId = randomUUID();
    const rejectedAction = { type: "cancel_order" as const, orderReference: "ORDER-REJECT-1" };
    await pool.query(
      `INSERT INTO tasks (tenant_id, id, conversation_id, task_type, status)
       VALUES ($1, $2, $3, 'approval:cancel_order', 'waiting_approval')`,
      [config.devTenantId, rejectTaskId, conversationId],
    );
    await pool.query(
      `INSERT INTO approval_requests
         (tenant_id, id, task_id, status, requested_action, action_hash, control_version)
       VALUES ($1, $2, $3, 'pending', $4::jsonb, $5, $6)`,
      [
        config.devTenantId,
        rejectApprovalId,
        rejectTaskId,
        JSON.stringify(rejectedAction),
        hashApprovalAction(rejectedAction),
        (await pool.query<{ control_version: string }>(
          "SELECT control_version::text FROM conversations WHERE tenant_id = $1 AND id = $2",
          [config.devTenantId, conversationId],
        )).rows[0].control_version,
      ],
    );
    const rejectKey = randomUUID();
    const rejected = await request(app)
      .post(`/v1/approvals/${rejectApprovalId}/decision`)
      .set({ ...authHeaders, "Idempotency-Key": rejectKey })
      .send({ decision: "reject", actionHash: hashApprovalAction(rejectedAction) })
      .expect(200);
    assert.equal(rejected.body.status, "rejected");
    const rejectedTask = await request(app)
      .get(`/v1/tasks/${rejectTaskId}`)
      .set(authHeaders)
      .expect(200);
    assert.equal(rejectedTask.body.status, "cancelled");

    const racingEventId = randomUUID();
    await request(app)
      .post(`/v1/test/conversations/${conversationId}/inbound`)
      .set(authHeaders)
      .send({ eventId: racingEventId, body: "أحتاج مساعدة إضافية" })
      .expect(201);
    const beforeMessages = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM conversation_messages
       WHERE tenant_id = $1 AND conversation_id = $2 AND sender_type = 'agent'`,
      [config.devTenantId, conversationId],
    );
    const provider = new DeferredAgentProvider();
    const pendingRun = runAgentTurn(
      pool,
      config.devTenantId,
      conversationId,
      provider,
    );
    await provider.started;
    detail = await request(app)
      .get(`/v1/conversations/${conversationId}`)
      .set(authHeaders)
      .expect(200);
    await request(app)
      .post(`/v1/conversations/${conversationId}/takeover`)
      .set(authHeaders)
      .send({ expectedControlVersion: detail.body.controlVersion })
      .expect(200);
    provider.complete({ type: "respond", body: "This must remain unsent." });
    const staleRun = await pendingRun;
    assert.equal(staleRun.status, "stale");
    const afterMessages = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM conversation_messages
       WHERE tenant_id = $1 AND conversation_id = $2 AND sender_type = 'agent'`,
      [config.devTenantId, conversationId],
    );
    assert.equal(afterMessages.rows[0].count, beforeMessages.rows[0].count);
    await pool.query(
      `UPDATE tenant_agent_settings
       SET enabled = false, provider = 'disabled', system_instructions = ''
       WHERE tenant_id = $1`,
      [config.devTenantId],
    );
  });

  it("scopes SSE events to the authenticated workspace", async () => {
    await pool.query(
      `INSERT INTO conversation_events
         (tenant_id, conversation_id, actor_type, event_type, metadata)
       VALUES ($1, $2, 'system', 'tenant_scope_probe', '{}'::jsonb),
              ($3, $4, 'system', 'tenant_scope_probe', '{}'::jsonb)`,
      [config.devTenantId, conversationId, foreignTenantId, foreignConversationId],
    );

    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The test server did not bind to a TCP port.");
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/events`, {
        headers: { ...authHeaders, "Last-Event-ID": "0" },
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      reader = response.body?.getReader();
      assert.ok(reader);
      let contents = "";
      const deadline = Date.now() + 5_000;
      while (!contents.includes(`"conversationId":"${conversationId}"`) && Date.now() < deadline) {
        const next = await reader.read();
        if (next.done) break;
        contents += new TextDecoder().decode(next.value);
      }
      assert.ok(contents.includes(`"conversationId":"${conversationId}"`));
      assert.equal(contents.includes(foreignConversationId), false);
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
