import "dotenv/config";
import { z } from "zod";

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);
const optionalText = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);
const optionalTelegramSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().regex(/^[A-Za-z0-9_-]{1,256}$/).optional(),
);

function isAuth0ManagementAudience(issuer?: string, audience?: string): boolean {
  if (!issuer || !audience) return false;
  const issuerUrl = new URL(issuer);
  let audienceUrl: URL;
  try {
    audienceUrl = new URL(audience);
  } catch {
    return false;
  }
  return (
    issuerUrl.hostname.endsWith(".auth0.com") &&
    audienceUrl.origin === issuerUrl.origin &&
    audienceUrl.pathname.replace(/\/+$/, "") === "/api/v2"
  );
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:5173"),
  DEV_AUTH_ENABLED: z.string().default("false"),
  DEV_AUTH_TOKEN: z.string().optional(),
  DEV_TENANT_ID: z.string().uuid().default("00000000-0000-4000-8000-000000000001"),
  DEV_USER_ID: z.string().uuid().default("00000000-0000-4000-8000-000000000002"),
  AUTH_ISSUER: optionalUrl,
  AUTH_AUDIENCE: optionalText,
  AUTH_JWKS_URL: optionalUrl,
  AGENT_PROVIDER: z.enum(["disabled", "fake", "openai"]).default("disabled"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().trim().min(1).max(100).default("gpt-4o-mini"),
  CHANNEL_ADAPTER: z.enum(["test", "telegram"]).default("test"),
  TELEGRAM_BOT_TOKEN: optionalText,
  TELEGRAM_WEBHOOK_SECRET: optionalTelegramSecret,
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  frontendOrigin: string;
  devAuthEnabled: boolean;
  devAuthToken: string | null;
  devTenantId: string;
  devUserId: string;
  authIssuer: string | null;
  authAudience: string | null;
  authJwksUrl: string | null;
  agentProvider: "disabled" | "fake" | "openai";
  openAiApiKey: string | null;
  openAiModel: string;
  channelAdapter: "test" | "telegram";
  telegramBotToken: string | null;
  telegramWebhookSecret: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const devAuthEnabled = parsed.DEV_AUTH_ENABLED === "true";
  const oidcValues = [parsed.AUTH_ISSUER, parsed.AUTH_AUDIENCE, parsed.AUTH_JWKS_URL];
  const oidcComplete = oidcValues.every((value) => Boolean(value));

  if (isAuth0ManagementAudience(parsed.AUTH_ISSUER, parsed.AUTH_AUDIENCE)) {
    throw new Error("AUTH_AUDIENCE must identify the application API, not Auth0 Management API");
  }
  if (parsed.NODE_ENV === "production" && devAuthEnabled) {
    throw new Error("DEV_AUTH_ENABLED must never be enabled in production");
  }
  if (parsed.NODE_ENV === "production" && !oidcComplete) {
    throw new Error("AUTH_ISSUER, AUTH_AUDIENCE, and AUTH_JWKS_URL are required in production");
  }
  if (parsed.NODE_ENV === "production" && parsed.AGENT_PROVIDER === "fake") {
    throw new Error("The fake agent provider is only available in development and tests.");
  }
  if (
    parsed.CHANNEL_ADAPTER === "telegram" &&
    (!parsed.TELEGRAM_BOT_TOKEN || !parsed.TELEGRAM_WEBHOOK_SECRET)
  ) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET are required for the Telegram adapter.");
  }
  if (parsed.NODE_ENV === "production" && parsed.CHANNEL_ADAPTER !== "telegram") {
    throw new Error("Production requires the Telegram adapter and its verified webhook configuration.");
  }
  if (devAuthEnabled && parsed.NODE_ENV !== "development" && parsed.NODE_ENV !== "test") {
    throw new Error("Development authentication is only available in development and tests");
  }
  if (devAuthEnabled && !parsed.DEV_AUTH_TOKEN) {
    throw new Error("DEV_AUTH_TOKEN is required when development authentication is enabled");
  }
  if (!devAuthEnabled && !oidcComplete && parsed.NODE_ENV !== "test") {
    throw new Error("Configure OIDC authentication or explicitly enable local development authentication");
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.API_HOST,
    port: parsed.API_PORT,
    databaseUrl: parsed.DATABASE_URL,
    frontendOrigin: parsed.FRONTEND_ORIGIN,
    devAuthEnabled,
    devAuthToken: parsed.DEV_AUTH_TOKEN ?? null,
    devTenantId: parsed.DEV_TENANT_ID,
    devUserId: parsed.DEV_USER_ID,
    authIssuer: parsed.AUTH_ISSUER ?? null,
    authAudience: parsed.AUTH_AUDIENCE ?? null,
    authJwksUrl: parsed.AUTH_JWKS_URL ?? null,
    agentProvider: parsed.AGENT_PROVIDER,
    openAiApiKey: parsed.OPENAI_API_KEY || null,
    openAiModel: parsed.OPENAI_MODEL,
    channelAdapter: parsed.CHANNEL_ADAPTER,
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN ?? null,
    telegramWebhookSecret: parsed.TELEGRAM_WEBHOOK_SECRET ?? null,
  };
}
