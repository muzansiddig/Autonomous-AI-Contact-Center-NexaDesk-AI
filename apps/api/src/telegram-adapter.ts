import { z } from "zod";
import {
  ChannelDeliveryError,
  type OutboundAdapter,
  type OutboundMessage,
} from "./test-adapter.js";

const telegramResponseSchema = z.object({
  ok: z.boolean(),
  result: z.object({ message_id: z.number().int().positive() }).optional(),
  error_code: z.number().int().optional(),
  parameters: z.object({ retry_after: z.number().int().positive().optional() }).optional(),
});

const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: z.object({
    message_id: z.number().int().positive(),
    chat: z.object({
      id: z.number().int(),
      type: z.string(),
    }),
    from: z.object({
      id: z.number().int(),
      first_name: z.string().max(128).optional(),
      last_name: z.string().max(128).optional(),
      username: z.string().max(128).optional(),
    }).optional(),
    text: z.string().min(1).max(4_000).optional(),
  }).optional(),
});

export type TelegramTextUpdate = {
  updateId: number;
  messageId: number;
  chatId: string;
  senderId: string;
  displayName: string;
  body: string;
};

export type ParsedTelegramUpdate =
  | { kind: "text"; value: TelegramTextUpdate }
  | { kind: "ignored"; updateId: number };

export function parseTelegramUpdate(payload: unknown): ParsedTelegramUpdate | null {
  const parsed = telegramUpdateSchema.safeParse(payload);
  if (!parsed.success) return null;
  const message = parsed.data.message;
  if (
    !message ||
    message.chat.type !== "private" ||
    !message.from ||
    !message.text?.trim()
  ) {
    return { kind: "ignored", updateId: parsed.data.update_id };
  }
  const sender = message.from;
  const displayName = [sender.first_name, sender.last_name].filter(Boolean).join(" ")
    || (sender.username ? `@${sender.username}` : `Telegram ${sender.id}`);
  return {
    kind: "text",
    value: {
      updateId: parsed.data.update_id,
      messageId: message.message_id,
      chatId: String(message.chat.id),
      senderId: String(sender.id),
      displayName,
      body: message.text.trim(),
    },
  };
}

export interface TelegramAdapterOptions {
  botToken: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export class TelegramOutboundAdapter implements OutboundAdapter {
  readonly name = "telegram";
  readonly capabilities = {
    text: true,
    inboundWebhooks: true,
    deliveryReceipts: false,
    providerIdempotency: false,
  };
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: TelegramAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  supports(channelType: string): boolean {
    return channelType === "telegram";
  }

  async send(message: OutboundMessage): Promise<{
    status: "accepted";
    providerMessageId: string;
  }> {
    if (!message.externalConversationId) {
      throw new ChannelDeliveryError("TELEGRAM_DESTINATION_MISSING", false, true);
    }
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(
        `https://api.telegram.org/bot${this.options.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: message.externalConversationId,
            text: message.body,
          }),
          signal: controller.signal,
        },
      );
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ChannelDeliveryError("TELEGRAM_OUTCOME_UNKNOWN", false, false);
      }
      const result = telegramResponseSchema.safeParse(payload);
      if (!result.success) {
        throw new ChannelDeliveryError("TELEGRAM_OUTCOME_UNKNOWN", false, false);
      }
      if (response.status === 429 || result.data.error_code === 429) {
        const retryAfterMs = result.data.parameters?.retry_after === undefined
          ? undefined
          : Math.min(60_000, result.data.parameters.retry_after * 1_000);
        throw new ChannelDeliveryError("TELEGRAM_RATE_LIMITED", true, true, retryAfterMs);
      }
      if (!response.ok || !result.data.ok) {
        if (response.status >= 500) {
          throw new ChannelDeliveryError("TELEGRAM_OUTCOME_UNKNOWN", false, false);
        }
        throw new ChannelDeliveryError("TELEGRAM_SEND_REJECTED", false, true);
      }
      if (!result.data.result) {
        throw new ChannelDeliveryError("TELEGRAM_OUTCOME_UNKNOWN", false, false);
      }
      return {
        status: "accepted",
        providerMessageId: String(result.data.result.message_id),
      };
    } catch (error) {
      if (error instanceof ChannelDeliveryError) throw error;
      throw new ChannelDeliveryError(
        timedOut ? "TELEGRAM_TIMEOUT" : "TELEGRAM_OUTCOME_UNKNOWN",
        false,
        false,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  classifyError(error: unknown): ChannelDeliveryError {
    if (error instanceof ChannelDeliveryError) return error;
    return new ChannelDeliveryError("TELEGRAM_OUTCOME_UNKNOWN", false, false);
  }
}
