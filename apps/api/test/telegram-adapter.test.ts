import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChannelDeliveryError, type OutboundMessage } from "../src/test-adapter.js";
import { parseTelegramUpdate, TelegramOutboundAdapter } from "../src/telegram-adapter.js";

const outboundMessage: OutboundMessage = {
  tenantId: "tenant-id",
  conversationId: "conversation-id",
  messageId: "message-id",
  idempotencyKey: "idempotency-id",
  channelType: "telegram",
  externalAccountId: "bot-id",
  externalConversationId: "987654321",
  body: "Hello from the mock adapter",
};

describe("Telegram adapter", () => {
  it("normalizes private text updates and ignores unsupported update kinds", () => {
    assert.deepEqual(parseTelegramUpdate({
      update_id: 12,
      message: {
        message_id: 34,
        chat: { id: 987654321, type: "private" },
        from: { id: 987654321, first_name: "Amina" },
        text: "  مرحبًا  ",
      },
    }), {
      kind: "text",
      value: {
        updateId: 12,
        messageId: 34,
        chatId: "987654321",
        senderId: "987654321",
        displayName: "Amina",
        body: "مرحبًا",
      },
    });
    assert.deepEqual(parseTelegramUpdate({
      update_id: 13,
      message: { message_id: 35, chat: { id: -1001, type: "group" } },
    }), { kind: "ignored", updateId: 13 });
    assert.equal(parseTelegramUpdate({ update_id: "bad" }), null);
  });

  it("confirms acceptance only after Telegram returns a valid provider message id", async () => {
    let url = "";
    let body = "";
    let authorizationHeaders = false;
    const adapter = new TelegramOutboundAdapter({
      botToken: "123456:test-token",
      fetchImpl: async (input, init) => {
        url = String(input);
        body = String(init?.body);
        authorizationHeaders = new Headers(init?.headers).has("Authorization");
        return new Response(JSON.stringify({
          ok: true,
          result: { message_id: 234 },
        }), { status: 200 });
      },
    });
    const result = await adapter.send(outboundMessage);
    assert.deepEqual(result, { status: "accepted", providerMessageId: "234" });
    assert.equal(url, "https://api.telegram.org/bot123456:test-token/sendMessage");
    assert.equal(body.includes("987654321"), true);
    assert.equal(authorizationHeaders, false);
  });

  it("classifies Telegram rate limits as safely retryable and honors bounded retry-after", async () => {
    const adapter = new TelegramOutboundAdapter({
      botToken: "mock-token",
      fetchImpl: async () => new Response(JSON.stringify({
        ok: false,
        error_code: 429,
        parameters: { retry_after: 2 },
      }), { status: 429 }),
    });
    await assert.rejects(
      adapter.send(outboundMessage),
      (error: unknown) => {
        assert.ok(error instanceof ChannelDeliveryError);
        assert.equal(error.retryable, true);
        assert.equal(error.safeToRetry, true);
        assert.equal(error.retryAfterMs, 2_000);
        return true;
      },
    );
  });

  it("treats network timeouts and ambiguous server errors as non-retryable unknown outcomes", async () => {
    const adapters = [
      new TelegramOutboundAdapter({
        botToken: "mock-token",
        fetchImpl: async () => { throw new Error("socket timed out"); },
      }),
      new TelegramOutboundAdapter({
        botToken: "mock-token",
        fetchImpl: async () => new Response(JSON.stringify({
          ok: false,
          error_code: 500,
        }), { status: 500 }),
      }),
    ];
    for (const adapter of adapters) {
      await assert.rejects(
        adapter.send(outboundMessage),
        (error: unknown) => {
          assert.ok(error instanceof ChannelDeliveryError);
          assert.equal(error.retryable, false);
          assert.equal(error.safeToRetry, false);
          return true;
        },
      );
    }
  });
});
