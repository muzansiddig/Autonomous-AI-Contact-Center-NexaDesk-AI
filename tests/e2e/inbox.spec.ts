import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, test } from "@playwright/test";
import { hashApprovalAction } from "../../apps/api/src/agent-runtime.js";

const tenantId = process.env.DEV_TENANT_ID ?? "00000000-0000-4000-8000-000000000001";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the isolated E2E fixtures.");

const pool = new Pool({ connectionString: databaseUrl });
const channelId = randomUUID();
const contactId = randomUUID();
const conversationId = randomUUID();
const teamId = randomUUID();
const foreignTenantId = randomUUID();
const foreignChannelId = randomUUID();
const foreignContactId = randomUUID();
const foreignConversationId = randomUUID();
const sourceKey = `e2e-${randomUUID()}`;
const customerName = `E2E Customer ${randomUUID().slice(0, 8)}`;
const conversationSubject = `E2E Conversation ${randomUUID()}`;
let fixturesReady = false;

test.beforeAll(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenant = await client.query("SELECT id FROM tenants WHERE id = $1 AND status = 'active'", [tenantId]);
    if (!tenant.rowCount) throw new Error("The active development tenant must be seeded before E2E tests.");
    await client.query(
      `INSERT INTO teams (tenant_id, id, name) VALUES ($1, $2, 'فريق الدعم التجريبي')`,
      [tenantId, teamId],
    );
    await client.query(
      `INSERT INTO channel_connections
         (tenant_id, id, channel_type, external_account_id, configuration_status, capabilities)
       VALUES ($1, $2, 'web', $3, 'ready', '{"text":true,"providerIdempotency":true}'::jsonb)`,
      [tenantId, channelId, `e2e-${channelId}`],
    );
    await client.query(
      `INSERT INTO contacts (tenant_id, id, display_name) VALUES ($1, $2, $3)`,
      [tenantId, contactId, customerName],
    );
    await client.query(
      `INSERT INTO conversations
         (tenant_id, id, contact_id, channel_connection_id, control_mode, control_version,
          status, priority, subject)
       VALUES ($1, $2, $3, $4, 'ai', 0, 'open', 'normal', $5)`,
      [tenantId, conversationId, contactId, channelId, conversationSubject],
    );

    await client.query(
      "INSERT INTO tenants (id, name) VALUES ($1, $2)",
      [foreignTenantId, `E2E isolated ${foreignTenantId}`],
    );
    await client.query(
      `INSERT INTO channel_connections
         (tenant_id, id, channel_type, external_account_id, configuration_status)
       VALUES ($1, $2, 'web', $3, 'ready')`,
      [foreignTenantId, foreignChannelId, `e2e-${foreignChannelId}`],
    );
    await client.query(
      `INSERT INTO contacts (tenant_id, id, display_name) VALUES ($1, $2, 'Foreign E2E Contact')`,
      [foreignTenantId, foreignContactId],
    );
    await client.query(
      `INSERT INTO conversations
         (tenant_id, id, contact_id, channel_connection_id, control_mode, control_version, subject)
       VALUES ($1, $2, $3, $4, 'ai', 0, 'Foreign E2E Conversation')`,
      [foreignTenantId, foreignConversationId, foreignContactId, foreignChannelId],
    );
    await client.query("COMMIT");
    fixturesReady = true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

test.afterAll(async () => {
  if (fixturesReady) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM knowledge_documents WHERE tenant_id = $1 AND source_key = $2",
        [tenantId, sourceKey],
      );
      await client.query(
        `DELETE FROM approval_requests
         WHERE tenant_id = $1 AND task_id IN (
           SELECT id FROM tasks WHERE tenant_id = $1 AND conversation_id = $2
         )`,
        [tenantId, conversationId],
      );
      await client.query(
        "DELETE FROM outbox_events WHERE tenant_id = $1 AND aggregate_id = $2",
        [tenantId, conversationId],
      );
      await client.query(
        "DELETE FROM conversation_events WHERE tenant_id = $1 AND conversation_id = $2",
        [tenantId, conversationId],
      );
      await client.query(
        "DELETE FROM conversation_messages WHERE tenant_id = $1 AND conversation_id = $2",
        [tenantId, conversationId],
      );
      await client.query(
        "DELETE FROM tasks WHERE tenant_id = $1 AND conversation_id = $2",
        [tenantId, conversationId],
      );
      await client.query("DELETE FROM conversations WHERE tenant_id = $1 AND id = $2", [tenantId, conversationId]);
      await client.query("DELETE FROM contacts WHERE tenant_id = $1 AND id = $2", [tenantId, contactId]);
      await client.query("DELETE FROM channel_connections WHERE tenant_id = $1 AND id = $2", [tenantId, channelId]);
      await client.query("DELETE FROM teams WHERE tenant_id = $1 AND id = $2", [tenantId, teamId]);

      await client.query("DELETE FROM conversation_events WHERE tenant_id = $1 AND conversation_id = $2", [foreignTenantId, foreignConversationId]);
      await client.query("DELETE FROM conversation_messages WHERE tenant_id = $1 AND conversation_id = $2", [foreignTenantId, foreignConversationId]);
      await client.query("DELETE FROM conversations WHERE tenant_id = $1 AND id = $2", [foreignTenantId, foreignConversationId]);
      await client.query("DELETE FROM contacts WHERE tenant_id = $1 AND id = $2", [foreignTenantId, foreignContactId]);
      await client.query("DELETE FROM channel_connections WHERE tenant_id = $1 AND id = $2", [foreignTenantId, foreignChannelId]);
      await client.query("DELETE FROM tenants WHERE id = $1", [foreignTenantId]);
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

test("inbox controls, replies, approvals, knowledge, reload, and tenant isolation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /صندوق الوارد/ })).toBeVisible();

  // 1. Test keyboard accessibility: Control+K focuses search box
  await page.keyboard.press("Control+k");
  const search = page.getByRole("textbox", { name: "البحث في المحادثات" });
  await expect(search).toBeFocused();

  // 2. Test filter tabs
  const row = page.getByRole("button").filter({ hasText: customerName });
  await page.getByRole("tab", { name: "ردود AI" }).click();
  await expect(row).toBeVisible();

  await page.getByRole("tab", { name: "تحت المراجعة" }).click();
  await expect(row).toHaveCount(0);

  await page.getByRole("tab", { name: "الكل" }).click();
  await search.fill(conversationSubject);
  await expect(row).toBeVisible();
  await row.click();

  await page.getByRole("button", { name: "استلام المحادثة" }).click();
  await expect(page.getByText("أنت تتحكم بالمحادثة")).toBeVisible();
  await page.getByRole("button", { name: "إيقاف AI" }).click();
  await expect(page.getByText("المساعد الذكي متوقف مؤقتًا")).toBeVisible();
  await page.getByRole("button", { name: "استئناف AI" }).click();
  await expect(page.getByText("المساعد الذكي يرد")).toBeVisible();
  await page.getByRole("button", { name: "استلام المحادثة" }).click();
  await expect(page.getByLabel("اكتب رسالة")).toBeEnabled();
  const reply = `E2E reply ${randomUUID()}`;
  await page.getByLabel("اكتب رسالة").fill(reply);
  await page.getByLabel("اكتب رسالة").press("Enter");
  await expect(page.locator(".message-bubble").filter({ hasText: reply })).toBeVisible();
  await page.getByRole("button", { name: "إعادة إلى AI" }).click();
  await expect(page.getByText("المساعد الذكي يرد")).toBeVisible();

  // 3. Test Assignment to team and Details panel toggle
  await page.getByLabel("إسناد إلى فريق").selectOption({ label: "فريق الدعم التجريبي" });
  await expect(page.locator(".assignee")).toContainText("فريق الدعم التجريبي");

  await page.getByRole("button", { name: "عرض تفاصيل العميل" }).click();
  await expect(page.getByRole("heading", { name: "تفاصيل العميل" })).toHaveCount(0);
  await page.getByRole("button", { name: "عرض تفاصيل العميل" }).click();
  await expect(page.getByRole("heading", { name: "تفاصيل العميل" })).toBeVisible();

  const refundTaskId = randomUUID();
  const refundApprovalId = randomUUID();
  const refundAction = { type: "refund" as const, orderReference: "E2E-ORDER-1", amount: 75 };
  await pool.query(
    `INSERT INTO tasks (tenant_id, id, conversation_id, task_type, status)
     VALUES ($1, $2, $3, 'approval:refund', 'waiting_approval')`,
    [tenantId, refundTaskId, conversationId],
  );
  await pool.query(
    `INSERT INTO approval_requests
       (tenant_id, id, task_id, requested_action, action_hash, control_version)
     SELECT $1, $2, $3, $4::jsonb, $5, control_version
     FROM conversations WHERE tenant_id = $1 AND id = $6`,
    [
      tenantId,
      refundApprovalId,
      refundTaskId,
      JSON.stringify(refundAction),
      hashApprovalAction(refundAction),
      conversationId,
    ],
  );
  await page.reload();
  await search.fill(conversationSubject);
  await page.getByRole("button").filter({ hasText: customerName }).click();
  await expect(page.getByText("استرداد مبلغ")).toBeVisible();
  await page.getByRole("button", { name: "موافقة" }).click();
  await expect(page.getByText("تمت الموافقة")).toBeVisible();
  await expect(page.getByText("الموافقة لا تنفّذ الإجراء الخارجي؛ لا يوجد منفّذ مفعّل.")).toBeVisible();
  const taskState = await pool.query<{ status: string }>(
    "SELECT status FROM tasks WHERE tenant_id = $1 AND id = $2",
    [tenantId, refundTaskId],
  );
  expect(taskState.rows[0].status).toBe("approved_not_executed");

  const rejectTaskId = randomUUID();
  const rejectApprovalId = randomUUID();
  const cancelAction = { type: "cancel_order" as const, orderReference: "E2E-ORDER-2" };
  await pool.query(
    `INSERT INTO tasks (tenant_id, id, conversation_id, task_type, status)
     VALUES ($1, $2, $3, 'approval:cancel_order', 'waiting_approval')`,
    [tenantId, rejectTaskId, conversationId],
  );
  await pool.query(
    `INSERT INTO approval_requests
       (tenant_id, id, task_id, requested_action, action_hash, control_version)
     SELECT $1, $2, $3, $4::jsonb, $5, control_version
     FROM conversations WHERE tenant_id = $1 AND id = $6`,
    [
      tenantId,
      rejectApprovalId,
      rejectTaskId,
      JSON.stringify(cancelAction),
      hashApprovalAction(cancelAction),
      conversationId,
    ],
  );
  await page.reload();
  await page.getByRole("button").filter({ hasText: customerName }).click();
  await expect(page.getByText("إلغاء طلب")).toBeVisible();
  await page.getByRole("button", { name: "رفض" }).click();
  await expect(page.getByText("مرفوضة")).toBeVisible();

  const foreignStatus = await page.evaluate(async (id) => {
    const response = await fetch(`/v1/conversations/${id}`);
    return response.status;
  }, foreignConversationId);
  expect(foreignStatus).toBe(404);

  await page.getByRole("button", { name: "قاعدة المعرفة" }).click();
  const knowledgeContent = `unique retrieval phrase ${randomUUID()}`;
  const sourceName = `E2E knowledge ${randomUUID().slice(0, 8)}`;
  await page.getByLabel("معرّف المصدر").fill(sourceKey);
  await page.getByLabel("اسم المستند").fill(sourceName);
  await page.getByRole("textbox", { name: "المحتوى" }).fill(knowledgeContent);
  await page.getByRole("button", { name: "حفظ إصدار جديد" }).click();
  await expect(page.getByText(sourceName)).toBeVisible();
  await page.getByLabel("عبارة البحث").fill(knowledgeContent);
  await page.getByRole("button", { name: "بحث" }).click();
  await expect(page.getByText(knowledgeContent)).toBeVisible();
  await page.getByRole("button", { name: `حذف ${sourceName}` }).click();
  await page.getByRole("button", { name: "بحث" }).click();
  await expect(page.getByText(knowledgeContent)).toHaveCount(0);

  await page.goto("/");
  await search.fill(conversationSubject);
  await page.getByRole("button").filter({ hasText: customerName }).click();
  await expect(page.locator(".message-bubble").filter({ hasText: reply })).toBeVisible();
  await expect(page.getByText("المساعد الذكي يرد")).toBeVisible();
});
