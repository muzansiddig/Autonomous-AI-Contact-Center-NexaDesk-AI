import pg from "pg";
import type { AppConfig } from "./config.js";

const { Pool } = pg;

export function createPool(config: AppConfig): pg.Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "nexadesk-api",
  });
}
