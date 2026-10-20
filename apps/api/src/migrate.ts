import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { loadConfig } from "./config.js";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const pool = new pg.Pool({ connectionString: loadConfig().databaseUrl, max: 1 });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(719284105)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = (await readdir(migrationsDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const name of files) {
      const sql = await readFile(path.join(migrationsDirectory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE name = $1",
        [name],
      );
      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Applied migration ${name} has changed; create a new migration instead.`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [name, checksum],
        );
        await client.query("COMMIT");
        console.info(`Applied migration ${name}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(719284105)").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

migrate().catch((error: unknown) => {
  console.error("Database migration failed:", error);
  process.exitCode = 1;
});
