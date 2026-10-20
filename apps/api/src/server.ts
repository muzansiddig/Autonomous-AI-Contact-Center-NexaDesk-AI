import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createApp } from "./app.js";
import { ChannelAdapterRouter } from "./channel-adapters.js";
import { processOutboxBatch, TestOutboundAdapter, type OutboundAdapter } from "./test-adapter.js";
import { TelegramOutboundAdapter } from "./telegram-adapter.js";

const config = loadConfig();
const pool = createPool(config);
const app = createApp(config, pool);
const adapters: OutboundAdapter[] = config.nodeEnv === "production"
  ? []
  : [new TestOutboundAdapter()];
if (config.channelAdapter === "telegram" && config.telegramBotToken) {
  adapters.push(new TelegramOutboundAdapter({ botToken: config.telegramBotToken }));
}
const adapter = new ChannelAdapterRouter(adapters);

const server = app.listen(config.port, config.host, () => {
  console.info(`NexaDesk API listening on http://${config.host}:${config.port}`);
});

let workerRunning = false;
const worker = setInterval(() => {
  if (workerRunning) return;
  workerRunning = true;
  void processOutboxBatch(pool, adapter)
    .catch(() => console.error("Outbound outbox worker failed."))
    .finally(() => {
      workerRunning = false;
    });
}, 500);
worker.unref();

async function shutdown(signal: string) {
  console.info(`Received ${signal}; shutting down.`);
  clearInterval(worker);
  server.close(async (error) => {
    await pool.end();
    if (error) {
      console.error("HTTP server shutdown failed:", error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
