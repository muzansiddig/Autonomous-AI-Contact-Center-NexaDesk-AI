import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import pg from "pg";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { splitKnowledgeContent } from "../src/knowledge.js";
import { ChannelDeliveryError, retryDelayMs, TestOutboundAdapter } from "../src/test-adapter.js";
import {
  assignConversationRequestSchema,
  controlRequestSchema,
  sendMessageRequestSchema,
} from "../../../shared/contracts.js";

const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://nexadesk:nexadesk_local_only@127.0.0.1:5432/nexadesk",
  DEV_AUTH_ENABLED: "false",
});
const pool = new pg.Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 100 });
const app = createApp(config, pool);

after(async () => {
  await pool.end();
});

describe("API foundation", () => {
  it("exposes a public liveness check", async () => {
    const response = await request(app).get("/health/live").expect(200);
    assert.deepEqual(response.body, { status: "ok" });
    assert.ok(response.headers["x-request-id"]);
  });

  it("requires authentication for tenant data", async () => {
    const response = await request(app).get("/v1/conversations").expect(401);
    assert.equal(response.body.error.code, "UNAUTHENTICATED");
    assert.equal(typeof response.body.error.requestId, "string");
  });

  it("requires authentication on assignment directories and live updates", async () => {
    for (const path of [
      "/v1/members",
      "/v1/teams",
      "/v1/channels",
      "/v1/knowledge/documents",
      "/v1/events",
    ]) {
      const response = await request(app).get(path).expect(401);
      assert.equal(response.body.error.code, "UNAUTHENTICATED");
    }
  });

  describe("channel and knowledge foundations", () => {
    it("uses bounded exponential delivery backoff", () => {
      assert.deepEqual(
        [1, 2, 3, 5, 10].map(retryDelayMs),
        [1_000, 2_000, 4_000, 16_000, 60_000],
      );
    });

    it("does not treat an ambiguous provider result as safely retryable", () => {
      const adapter = new TestOutboundAdapter();
      const failure = adapter.classifyError(new Error("provider timeout"));
      assert.ok(failure instanceof ChannelDeliveryError);
      assert.equal(failure.retryable, false);
      assert.equal(failure.safeToRetry, false);
    });

    it("splits registered knowledge into bounded chunks with contextual overlap", () => {
      const input = `${"section-one ".repeat(100)}\n\n${"section-two ".repeat(100)}`;
      const chunks = splitKnowledgeContent(input);
      assert.ok(chunks.length > 1);
      assert.ok(chunks.every((chunk) => chunk.length <= 1_200));
      assert.ok(chunks[0].includes("section-one"));
      assert.ok(chunks.at(-1)?.includes("section-two"));
    });
  });

  it("fails closed when the identity provider has not been configured", async () => {
    const response = await request(app)
      .get("/v1/conversations")
      .set("Authorization", "Bearer placeholder-token")
      .expect(503);
    assert.equal(response.body.error.code, "AUTH_NOT_CONFIGURED");
  });

  it("rejects malformed OIDC bearer tokens as authentication failures", async () => {
    const oidcConfig = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://nexadesk:nexadesk_local_only@127.0.0.1:5432/nexadesk",
      DEV_AUTH_ENABLED: "false",
      AUTH_ISSUER: "https://identity.example.invalid/",
      AUTH_AUDIENCE: "nexadesk-api",
      AUTH_JWKS_URL: "https://identity.example.invalid/.well-known/jwks.json",
    });
    const oidcApp = createApp(oidcConfig, pool);
    const response = await request(oidcApp)
      .get("/v1/conversations")
      .set("Authorization", "Bearer not-a-jwt")
      .expect(401);
    assert.equal(response.body.error.code, "UNAUTHENTICATED");
  });

  it("does not write bearer tokens to application logs", async () => {
    const marker = "sensitive-token-marker";
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => logged.push(values.join(" "));
    try {
      await request(app)
        .get("/v1/conversations")
        .set("Authorization", `Bearer ${marker}`)
        .expect(503);
      assert.equal(logged.join(" ").includes(marker), false);
    } finally {
      console.error = originalError;
    }
  });

  it("does not log an invalid OIDC bearer token", async () => {
    const oidcConfig = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://127.0.0.1:5432/nexadesk",
      DEV_AUTH_ENABLED: "false",
      AUTH_ISSUER: "https://identity.example.invalid/",
      AUTH_AUDIENCE: "nexadesk-api",
      AUTH_JWKS_URL: "https://identity.example.invalid/.well-known/jwks.json",
    });
    const marker = "sensitive-invalid-token-marker";
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => logged.push(values.join(" "));
    try {
      const response = await request(createApp(oidcConfig, pool))
        .get("/v1/conversations")
        .set("Authorization", `Bearer ${marker}`)
        .expect(401);
      assert.equal(response.body.error.code, "UNAUTHENTICATED");
      assert.equal(logged.join(" ").includes(marker), false);
    } finally {
      console.error = originalError;
    }
  });
});

describe("API request contracts", () => {
  it("rejects empty and oversized manual replies", () => {
    const base = {
      clientMessageId: "00000000-0000-4000-8000-000000000010",
      expectedControlVersion: 0,
    };
    assert.equal(sendMessageRequestSchema.safeParse({ ...base, body: "  " }).success, false);
    assert.equal(sendMessageRequestSchema.safeParse({ ...base, body: "x".repeat(4001) }).success, false);
    assert.equal(sendMessageRequestSchema.safeParse({ ...base, body: "hello" }).success, true);
  });

  it("requires exactly one assignment target", () => {
    const version = { expectedControlVersion: 3 };
    const user = { assigneeUserId: "00000000-0000-4000-8000-000000000010" };
    assert.equal(assignConversationRequestSchema.safeParse({ ...version, ...user }).success, true);
    assert.equal(assignConversationRequestSchema.safeParse(version).success, false);
    assert.equal(
      assignConversationRequestSchema.safeParse({
        ...version,
        ...user,
        teamId: "00000000-0000-4000-8000-000000000011",
      }).success,
      false,
    );
  });

  it("requires an expected control version for state changes", () => {
    assert.equal(controlRequestSchema.safeParse({ expectedControlVersion: 0 }).success, true);
    assert.equal(controlRequestSchema.safeParse({}).success, false);
    assert.equal(controlRequestSchema.safeParse({ expectedControlVersion: -1 }).success, false);
  });
});

describe("authentication configuration", () => {
  it("accepts the NexaDesk custom API as its Auth0 audience", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://127.0.0.1:5432/nexadesk",
      DEV_AUTH_ENABLED: "false",
      AUTH_ISSUER: "https://tenant.auth0.com/",
      AUTH_AUDIENCE: "https://nexadesk-api",
      AUTH_JWKS_URL: "https://tenant.auth0.com/.well-known/jwks.json",
    });
    assert.equal(config.authAudience, "https://nexadesk-api");
  });

  it("rejects the Auth0 Management API as the application audience", () => {
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: "test",
          DATABASE_URL: "postgresql://127.0.0.1:5432/nexadesk",
          DEV_AUTH_ENABLED: "false",
          AUTH_ISSUER: "https://tenant.auth0.com/",
          AUTH_AUDIENCE: "https://tenant.auth0.com/api/v2/",
          AUTH_JWKS_URL: "https://tenant.auth0.com/.well-known/jwks.json",
        }),
      /AUTH_AUDIENCE must identify the application API, not Auth0 Management API/,
    );
  });

  it("refuses development authentication in production", () => {
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: "production",
          DATABASE_URL: "postgresql://example.invalid/db",
          DEV_AUTH_ENABLED: "true",
          DEV_AUTH_TOKEN: "not-a-real-secret",
          AUTH_ISSUER: "https://identity.example.invalid/",
          AUTH_AUDIENCE: "nexadesk",
          AUTH_JWKS_URL: "https://identity.example.invalid/.well-known/jwks.json",
        }),
      /DEV_AUTH_ENABLED must never be enabled in production/,
    );
  });

  it("accepts blank optional OIDC settings in the local example environment", () => {
    const local = loadConfig({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://nexadesk:nexadesk_local_only@127.0.0.1:5432/nexadesk",
      DEV_AUTH_ENABLED: "true",
      DEV_AUTH_TOKEN: "local-only",
      AUTH_ISSUER: "",
      AUTH_AUDIENCE: "",
      AUTH_JWKS_URL: "",
    });
    assert.equal(local.authIssuer, null);
    assert.equal(local.devAuthEnabled, true);
  });

  it("keeps OpenAI safely unavailable when no server API key is configured", async () => {
    const openAiConfig = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://127.0.0.1:5432/nexadesk",
      DEV_AUTH_ENABLED: "true",
      DEV_AUTH_TOKEN: "local-test-token",
      AGENT_PROVIDER: "openai",
      OPENAI_API_KEY: "",
    });
    assert.equal(openAiConfig.agentProvider, "openai");
    assert.equal(openAiConfig.openAiApiKey, null);
    const response = await request(createApp(openAiConfig, pool))
      .put("/v1/agent/settings")
      .set("Authorization", "Bearer local-test-token")
      .send({ enabled: true, provider: "openai", systemInstructions: "" })
      .expect(409);
    assert.equal(response.body.error.code, "AGENT_PROVIDER_UNAVAILABLE");
  });

  it("requires both Telegram credentials when selecting the Telegram adapter", () => {
    assert.throws(
      () => loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://127.0.0.1:5432/nexadesk",
        DEV_AUTH_ENABLED: "false",
        CHANNEL_ADAPTER: "telegram",
      }),
      /TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET are required/,
    );
  });
});
