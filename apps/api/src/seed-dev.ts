import pg from "pg";
import { loadConfig } from "./config.js";

async function seedDevelopmentTenant() {
  const config = loadConfig();
  if (config.nodeEnv === "production" || !config.devAuthEnabled) {
    throw new Error("The development seed can only run with local development authentication enabled.");
  }

  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO tenants (id, name) VALUES ($1, 'متجر نُقطة') ON CONFLICT (id) DO NOTHING",
      [config.devTenantId],
    );
    await client.query(
      `INSERT INTO users (id, identity_issuer, identity_subject, display_name, email)
       VALUES ($1, 'local-dev', 'local-agent', 'Local Development Agent', 'local@example.invalid')
       ON CONFLICT (identity_issuer, identity_subject) DO NOTHING`,
      [config.devUserId],
    );
    await client.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role)
       VALUES ($1, $2, 'tenant_admin')
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [config.devTenantId, config.devUserId],
    );
    await client.query(
      `INSERT INTO channel_connections
         (tenant_id, id, channel_type, external_account_id, configuration_status, capabilities)
       VALUES ($1, '00000000-0000-4000-8000-000000000003', 'web', 'local-test-adapter',
               'ready', '{"text":true,"inboundWebhooks":true,"deliveryReceipts":true,"providerIdempotency":true}'::jsonb)
       ON CONFLICT (tenant_id, id) DO UPDATE
       SET configuration_status = EXCLUDED.configuration_status,
           capabilities = EXCLUDED.capabilities`,
      [config.devTenantId],
    );
    await client.query(
      `INSERT INTO contacts (tenant_id, id, display_name, email, phone)
       VALUES ($1, '00000000-0000-4000-8000-000000000004', 'سارة العتيبي',
               'sara.alotaibi@example.invalid', '+966 55 821 4902')
       ON CONFLICT (tenant_id, id) DO NOTHING`,
      [config.devTenantId],
    );
    await client.query(
      `INSERT INTO conversations
         (tenant_id, id, contact_id, channel_connection_id, control_mode, control_version,
          priority, subject, unread_count, tags)
       VALUES ($1, '00000000-0000-4000-8000-000000000005',
               '00000000-0000-4000-8000-000000000004',
               '00000000-0000-4000-8000-000000000003',
               'ai', 0, 'high', 'استفسار عن حالة الطلب', 2, ARRAY['طلب #48291', 'توصيل'])
       ON CONFLICT (tenant_id, id) DO NOTHING`,
      [config.devTenantId],
    );
    await client.query(
      `INSERT INTO conversation_messages
         (tenant_id, id, conversation_id, direction, sender_type, body, delivery_status)
       VALUES
         ($1, '00000000-0000-4000-8000-000000000006',
          '00000000-0000-4000-8000-000000000005', 'inbound', 'customer',
          'مرحبًا، أحتاج معرفة حالة طلبي.', NULL),
         ($1, '00000000-0000-4000-8000-000000000007',
          '00000000-0000-4000-8000-000000000005', 'outbound', 'agent',
          'أهلًا! أتحقق من حالة الطلب الآن.', 'accepted')
       ON CONFLICT (tenant_id, id) DO NOTHING`,
      [config.devTenantId],
    );
    await client.query(
      `INSERT INTO conversation_events
         (tenant_id, conversation_id, actor_type, event_type, metadata)
       SELECT $1, $2, event.actor_type, 'message_created', event.metadata::jsonb
       FROM (VALUES
         ('customer', '{"messageId":"00000000-0000-4000-8000-000000000006"}'),
         ('agent', '{"messageId":"00000000-0000-4000-8000-000000000007"}')
       ) AS event(actor_type, metadata)
       WHERE NOT EXISTS (
         SELECT 1 FROM conversation_events existing
         WHERE existing.tenant_id = $1 AND existing.conversation_id = $2
           AND existing.event_type = 'message_created'
           AND existing.metadata->>'messageId' = event.metadata::jsonb->>'messageId'
       )`,
      [config.devTenantId, "00000000-0000-4000-8000-000000000005"],
    );
    await client.query("COMMIT");
    console.info("Development tenant and user are ready.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

seedDevelopmentTenant().catch((error: unknown) => {
  console.error("Development seed failed:", error);
  process.exitCode = 1;
});
