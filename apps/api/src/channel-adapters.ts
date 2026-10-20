import {
  ChannelDeliveryError,
  type OutboundAdapter,
  type OutboundMessage,
} from "./test-adapter.js";

export class ChannelAdapterRouter implements OutboundAdapter {
  readonly name = "channel-router";
  readonly capabilities = {
    text: true,
    inboundWebhooks: true,
    deliveryReceipts: false,
    providerIdempotency: false,
  };

  constructor(private readonly adapters: OutboundAdapter[]) {}

  supports(channelType: string): boolean {
    return this.adapters.some((adapter) => adapter.supports(channelType));
  }

  async send(message: OutboundMessage) {
    const adapter = this.adapters.find((candidate) => candidate.supports(message.channelType));
    if (!adapter) {
      throw new ChannelDeliveryError("UNSUPPORTED_CHANNEL", false, true);
    }
    return adapter.send(message);
  }

  classifyError(error: unknown): ChannelDeliveryError {
    if (error instanceof ChannelDeliveryError) return error;
    return new ChannelDeliveryError("DELIVERY_OUTCOME_UNKNOWN", false, false);
  }
}
