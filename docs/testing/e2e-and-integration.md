# Integration and end-to-end testing

## Prerequisites

- Node.js 20 or newer and npm.
- Docker Desktop and the repository PostgreSQL Compose service.
- A local `.env` copied from `.env.example`, with `DEV_AUTH_ENABLED=true`, a non-empty local-only `DEV_AUTH_TOKEN`, and `VITE_APP_MODE=api`.
- The configured development database and `DEV_TENANT_ID`.
- Playwright Chromium for the browser test.

The Playwright configuration fails closed unless local development authentication, a token, a database URL, and API mode are configured. The API proxy injects the local token server-side; it is not delivered to browser JavaScript. Do not use this configuration with a production or shared database.

## Safe local run

From the repository root, use PowerShell:

```powershell
docker compose up -d postgres
npm.cmd install
npm.cmd run db:migrate
npm.cmd run db:seed:dev
npx.cmd playwright install chromium
npm.cmd run test:api
npm.cmd run test:integration
npm.cmd run test:evals
npm.cmd run test:e2e
npm.cmd run lint
npm.cmd run build
npm.cmd audit --omit=dev
```

Migrations are checksum-tracked and re-runnable. The development seed uses `ON CONFLICT` handling; it does not reset the database. Do not use `docker compose down -v`, truncate tables, or run these commands against a production database.

`npm.cmd run test:integration` runs both `apps/api/test/integration.test.ts` and `apps/api/test/business-flows.test.ts` (11 tests in total). The integration tests construct fake agent providers explicitly, independent of the server's `.env` provider setting.

`npm.cmd run test:evals` runs the deterministic AI Agent Evaluation Suite (`apps/api/test/run-evals.ts`) across 14 scenarios and 11 safety and quality categories.

## E2E fixture lifecycle and coverage

`tests/e2e/inbox.spec.ts` creates a unique test channel, contact, conversation, team, foreign tenant, and foreign conversation. It exercises:
1. **Keyboard Accessibility**: `Control+K` / `⌘K` triggers immediate focus on the conversation search box.
2. **Filter Tabs**: Navigating across "الكل", "غير مقروء", "ردود AI", "تحت المراجعة", and "متوقف", verifying dynamic list updates.
3. **Conversation Selection & Takeover**: Selects conversation, takes over to human control, pauses AI, resumes AI, hands back.
4. **Manual Replies & Outbox**: Dispatches manual reply with server-confirmed delivery status.
5. **Team Assignment**: Selects team from directory dropdown in `DetailsPanel`, verifies server persistence and UI assignee label update.
6. **Details Panel Toggling**: Tests hiding and showing the customer details panel.
7. **Approvals Flow**: Seeds approval requests for refund and order cancellation; executes approve and reject decisions; verifies `approved_not_executed` status in database.
8. **Knowledge Management**: Uploads a new Markdown document with source key, searches for unique content, deletes document, and verifies content is no longer retrieved.
9. **Cross-Tenant Isolation**: Proves that authenticated requests to foreign tenant conversations return 404.
10. **Persisted State on Reload**: Reloads the page, re-queries conversation, and confirms persisted reply and status.

The `afterAll` hook deletes only these generated records in dependency order and leaves seeded development data untouched.

If the test process is forcibly terminated before teardown, randomly named fixture records may remain. Inspect the records using their E2E-specific identifiers before any cleanup; never reset or delete the database to clean up a failed run.

The test uses the development proxy, not an Auth0 login. Therefore it does not verify Auth0 redirects, login/logout UX, token refresh, or tenant membership provisioning from a live identity provider. The API integration suite separately validates locally signed JWTs, wrong audience/expiry, missing/revoked membership, and tenant isolation.

## Security cases and untested behavior

Covered by local automated tests:

- Unauthenticated requests are rejected by protected APIs.
- JWT audience, issuer, expiry, and active tenant membership are validated.
- A tenant cannot retrieve another tenant's conversation; SSE and knowledge are tenant-scoped.
- Manual replies with stale control versions are rejected; idempotent duplicates do not create another message.
- Control changes invalidate queued sends and running agent results are revalidated before persistence.
- Telegram webhook secrets and event de-duplication are exercised with a mock adapter.
- Approval decisions verify role, exact action hash, idempotency replay, and current conversation context.
- Provider error, timeout, malformed response, retry bounds, and sanitized error behavior are tested with mocked fetch.
- AI Agent safety assertions (prompt injection defense, hallucination prevention, approval enforcement, sensitive data sanitization) pass 100%.
- Tests assert that bearer tokens do not appear in application logs.

Not covered by these local tests:

- A live Auth0 tenant or browser OIDC login/logout.
- Real Telegram bot credentials, HTTPS ingress, delivery, or provider reconciliation.
- Real OpenAI credentials, model output quality, or any paid inference.
- Browser offline/reconnection fault injection, persistent cross-browser sessions, or high-concurrency load.
- Execution of an approved refund/cancellation: no action executor is implemented.

See [feature-traceability.md](./feature-traceability.md) for behavior-by-behavior status.
