# NexaDesk AI

**An AI-assisted customer conversation platform with human-supervised operations.**

NexaDesk AI brings customer conversations, team assignment, knowledge lookup, controlled AI-agent workflows, approvals, and operational events into one workspace. The design keeps authorization and control on the server, with explicit boundaries between simulated development behavior and real provider integrations.

> **Project status:** Early-stage development. Several backend workflows and safeguards are implemented, but this repository is not yet a production-ready autonomous contact center. See [Current capabilities and limitations](#current-capabilities-and-limitations).

## Why NexaDesk AI?

Customer support automation needs more than generated replies. It needs traceable state changes, tenant isolation, safe message handling, human takeover, and clear evidence of what has—and has not—actually executed.

NexaDesk AI is being developed around these principles:

- **Human control:** agents can be paused and conversations taken over by a human.
- **Server-authoritative state:** the API owns conversation and control state in API mode.
- **Tenant isolation:** a tenant identifier selects a workspace; server-side membership checks authorize access.
- **Safer message processing:** transactional outbox records, idempotency keys, and conservative handling of ambiguous outcomes.
- **Explicit AI configuration:** the default agent provider is disabled; deterministic fake-provider tests do not call a live model.
- **Observable behavior:** API errors include structured codes and request IDs, and event streams support authenticated reconnection.

## Core capabilities

| Area | Current implementation |
| --- | --- |
| Conversation workspace | Search, filtering, cursor pagination, conversation details, timeline, and read state through the API |
| Human operations | Assignment, takeover, pause AI, resume AI, and optimistic control-version checks |
| Messaging | Manual replies with state checks and idempotency; outbox-based processing |
| Live updates | Server-Sent Events (SSE) with Bearer authentication and reconnection support |
| Workspace access | OIDC/JWT validation and active tenant-membership checks |
| Knowledge base | Tenant-scoped text/Markdown documents and lexical search using PostgreSQL `ILIKE` |
| Agent workflows | API for agent settings, runs, tasks, and approvals; fake provider for deterministic local tests |
| Telegram | Private text-message adapter with webhook-secret validation and update deduplication |
| Quality checks | Type checks, API and integration tests, Playwright E2E tests, linting, production build, and dependency audit scripts |

Some capabilities are API-only or simulated in the current version. In particular, an approval record does not execute an external action, and a test adapter's `accepted` status is not proof of delivery.

## Architecture at a glance

```text
Browser UI (Vite)
    │
    ├── /v1 and /health through the development proxy
    ▼
Node.js API
    ├── Authentication and tenant authorization
    ├── Conversation, message, team, and member APIs
    ├── Knowledge and agent APIs
    ├── Control-version and idempotency checks
    └── Transactional outbox / event processing
    │
    ▼
PostgreSQL
    ├── Conversations and messages
    ├── Tenant-scoped knowledge
    ├── Tasks and approvals
    └── Outbox and event data

External adapters (configured separately)
    └── Telegram private text messages
```

The frontend uses API mode by default. Demo mode is an explicit local-development option and is rejected by the production build. Shared request and response contracts are defined in `shared/contracts.ts`; database migrations are in `apps/api/migrations`.

## Technology

- **Runtime:** Node.js 20+
- **Frontend development:** Vite
- **Backend:** Node.js API with TypeScript
- **Database:** PostgreSQL
- **Local infrastructure:** Docker Compose / Docker Desktop
- **Authentication:** Auth0 OIDC, Authorization Code + PKCE, JWT validation
- **Realtime updates:** Server-Sent Events (SSE)
- **Browser E2E:** Playwright
- **AI provider adapter:** disabled by default; deterministic fake provider for local tests, plus an optional server-side OpenAI Chat Completions adapter

## Run locally on Windows

### Prerequisites

- Node.js 20 or newer
- Docker Desktop running
- PowerShell
- Git

### 1. Clone and configure

```powershell
git clone https://github.com/muzansiddig/Autonomous-AI-Contact-Center-NexaDesk-AI.git
cd Autonomous-AI-Contact-Center-NexaDesk-AI

Copy-Item .env.example .env

$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$token = [Convert]::ToBase64String($bytes)
$contents = [IO.File]::ReadAllText(".env")
[IO.File]::WriteAllText(
  ".env",
  [regex]::Replace($contents, "(?m)^DEV_AUTH_TOKEN=.*$", "DEV_AUTH_TOKEN=$token")
)
$token = $null
```

The generated development token should remain in `.env`. Do not commit or share this file.

### 2. Start PostgreSQL and initialize the database

```powershell
docker compose up -d postgres
npm.cmd install
npm.cmd run db:migrate
npm.cmd run db:seed:dev
```

Compose uses host port `5433` by default. If that port is already occupied, change both `POSTGRES_PORT` and `DATABASE_URL` in `.env` to the same available port. Do not stop another service just to free the port.

### 3. Start the API

In a dedicated PowerShell window:

```powershell
npm.cmd run dev:api
```

The API listens at `http://127.0.0.1:3000`.

### 4. Start the frontend

In a second PowerShell window:

```powershell
npm.cmd run dev
```

Open `http://127.0.0.1:5173`.

Vite proxies `/v1` and `/health` to the API. In local development only, the Vite server adds `DEV_AUTH_TOKEN` to proxied requests on the server side; the token is not exposed to browser JavaScript or production assets. Vite binds to loopback.

- `GET /health/live` is the public liveness check.
- `GET /health/ready` checks PostgreSQL readiness.
- `DEV_AUTH_ENABLED` is for local development and tests and is rejected in production.
- Do not run test suites against a production or shared database.
- Do not use `docker compose down -v` unless you intentionally want to delete the persistent database volume.

## Authentication: Auth0 OIDC

The frontend uses `@auth0/auth0-react` with Authorization Code + PKCE. The SDK stores credentials in memory rather than `localStorage`.

1. In Auth0, create an API for NexaDesk under **Applications → APIs**. Use an application-specific identifier such as `https://nexadesk-api` and record the exact value.
2. Configure the API to use RS256 and register a Single Page Application.
3. Add `http://127.0.0.1:5173` to the SPA's Allowed Callback URLs, Allowed Logout URLs, and Allowed Web Origins.
4. Set `AUTH_AUDIENCE` and `VITE_AUTH0_AUDIENCE` to the API identifier. Configure `AUTH_ISSUER`, `AUTH_JWKS_URL`, `VITE_AUTH0_DOMAIN`, and `VITE_AUTH0_CLIENT_ID` using `.env.example` as a guide.
5. Set `DEV_AUTH_ENABLED=false` to test the actual OIDC/JWT path, then restart both API and frontend.

Do not use the Auth0 Management API audience for the application API. Never put a client secret or access token in a `VITE_*` variable, frontend code, logs, or the repository. Values prefixed with `VITE_*` are public configuration.

The API validates active tenant membership for each request. `X-Tenant-Id` / `VITE_TENANT_ID` selects the requested workspace; it is not an authorization mechanism. The inbox remains unavailable in API mode until required Auth0 settings are configured.

## API overview

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/v1/conversations` | Search, filter, and cursor-paginate conversations |
| GET | `/v1/conversations/:id` | Retrieve conversation details |
| GET | `/v1/conversations/:id/timeline` | Read messages and events with pagination |
| POST | `/v1/conversations/:id/read` | Mark a conversation as read |
| POST | `/v1/conversations/:id/takeover` | Transfer control to a human |
| POST | `/v1/conversations/:id/pause-ai` | Pause AI handling |
| POST | `/v1/conversations/:id/resume-ai` | Resume AI handling |
| GET | `/v1/members`, `/v1/teams` | List workspace members and teams |
| POST | `/v1/conversations/:id/assign` | Assign a conversation |
| POST | `/v1/conversations/:id/messages` | Send a manual reply |
| GET | `/v1/messages/:id` | Read message processing status |
| GET | `/v1/events` | Subscribe to authenticated SSE events |
| GET | `/v1/tasks`, `/v1/tasks/:id` | Read task state |
| GET | `/v1/approvals` | List approvals |
| GET/POST | `/v1/knowledge/documents` | List or add knowledge documents |
| DELETE | `/v1/knowledge/documents/:id` | Delete a knowledge document |
| GET | `/v1/knowledge/search?q=...` | Search tenant-scoped knowledge |
| PUT | `/v1/agent/settings` | Configure agent settings |
| POST | `/v1/conversations/:id/agent-runs` | Start an agent run |

Shared contracts and request validation are in `shared/contracts.ts`. API errors include `code`, `requestId`, and `retryable`. A stale control version returns `409 STALE_CONTROL_VERSION`. Manual message sending checks conversation state, control version, and `Idempotency-Key`.

## Messaging and delivery semantics

Manual replies write the message and outbox event in a database transaction. The worker retries only failures explicitly classified as safe to retry. An ambiguous external outcome is marked `unknown` and is not automatically resent. When a retry is explicitly offered, the same idempotency key is retained.

The local test adapter does not contact a real messaging provider. Its `accepted` status means accepted by the adapter, not delivered to a customer.

## Telegram adapter (optional)

The current adapter supports **private text messages only**. Groups, media, and Telegram delivery/read receipts are not supported.

To configure a test integration:

1. Create a bot with Telegram's BotFather.
2. Set `TELEGRAM_BOT_TOKEN` and a random `TELEGRAM_WEBHOOK_SECRET` in the server-side `.env` only. Use letters, digits, underscores, or hyphens for the webhook secret.
3. Set `CHANNEL_ADAPTER=telegram` and restart the API.
4. Provide a public HTTPS API endpoint and create a ready Telegram channel record for an authorized tenant through the trusted database setup procedure.
5. Register the webhook URL as `https://<api-host>/webhooks/telegram/<channel-id>`, using the same value for Telegram's `secret_token` and `TELEGRAM_WEBHOOK_SECRET`.

The webhook validates `X-Telegram-Bot-Api-Secret-Token` and deduplicates incoming updates. A successful Telegram Bot API response is recorded as `accepted`, not `delivered`.

**Current limitation:** channel connections cannot yet be created through a dedicated admin UI or admin API. The repository's tests use a mocked `fetch` and local PostgreSQL; no real bot credentials or live Telegram messages have been used in the documented test runs. Use a test account and an authorized environment.

## Knowledge and AI agents

### Knowledge base

The UI supports text/Markdown documents, replacing document versions, deleting documents, and lexical search. Documents and chunks are tenant-scoped. Search currently uses PostgreSQL `ILIKE`; semantic search, embeddings, file upload, and OCR are not implemented.

Adding, replacing, and deleting documents requires a tenant administrator or supervisor role.

### Agent provider configuration

- `AGENT_PROVIDER=disabled` is the default.
- `AGENT_PROVIDER=fake` enables deterministic local tests without external model calls or paid services. Stop the API before changing the setting, then restart it.
- `AGENT_PROVIDER=openai` uses the server-side OpenAI Chat Completions adapter. Configure `OPENAI_API_KEY` and `OPENAI_MODEL` on the server, then explicitly enable the provider for an authorized tenant through `PUT /v1/agent/settings`.

The model is not called until the tenant enables the agent and an agent run is started. Never expose the API key in browser code, logs, Git, or chat messages. The fake provider is rejected in production.

For a local fake-agent test, with `DEV_AUTH_ENABLED=true`, configure the tenant agent using `PUT /v1/agent/settings` with a payload such as:

```json
{
  "enabled": true,
  "provider": "fake",
  "systemInstructions": "Follow the test scenario."
}
```

Then submit a simulated inbound event through `POST /v1/test/conversations/:id/inbound` and start a run through `POST /v1/conversations/:id/agent-runs`. This development-only endpoint is not a real provider webhook.

Agent decisions are limited to defined types. Approval decisions are recorded through `POST /v1/approvals/:id/decision` with an `actionHash`. **Recording an approval does not execute a refund, cancellation, or other external action.** A task/approval execution engine and a complete agent/task/approval management UI are not yet implemented.

## Testing and quality checks

Run the checks from the repository root in PowerShell:

```powershell
npm.cmd run typecheck
npm.cmd run typecheck:api
npm.cmd run test:api
npm.cmd run test:integration
npm.cmd run test:e2e
npm.cmd run lint
npm.cmd run build
npm.cmd audit --omit=dev
```

PostgreSQL integration tests require the local development database configured above. They use an explicit fake agent provider and should not reset the database. Playwright E2E tests require Chromium:

```powershell
npx.cmd playwright install chromium
```

The E2E suite uses the local development auth path with `DEV_AUTH_ENABLED=true`; it does **not** verify a real Auth0 login. Never run these tests against production or a shared database.

Current test coverage includes authentication and tenant membership, JWT validation, prevention of token leakage to logs, concurrent control changes and stale versions, message/approval/webhook idempotency, outbox behavior, tenant boundaries for SSE and knowledge, and core frontend paths.

See the detailed documentation:

- [Feature traceability matrix](./docs/testing/feature-traceability.md)
- [E2E and integration test guide](./docs/testing/e2e-and-integration.md)
- [AI evaluation notes](./docs/testing/ai-evaluations.md)

Passing these checks does not by itself prove real Auth0 login, live Telegram delivery, live-model response quality, or execution of external actions after approval.

## Current capabilities and limitations

NexaDesk AI is an actively developed project, not a claim of a fully production-ready autonomous contact center.

**Implemented or covered by local tests**
- API-backed conversation and control flows
- Tenant membership and JWT-related safeguards
- Transactional outbox and idempotency behavior
- Tenant-scoped lexical knowledge search
- Deterministic fake-agent workflows
- Simulated Telegram adapter tests
- Core Playwright user journeys

**Not yet verified or not yet implemented**
- Real Auth0 login in the automated E2E suite
- Live Telegram bot integration and customer-message delivery
- Live LLM quality and production evaluation thresholds
- Semantic knowledge retrieval, embeddings, file upload, and OCR
- Admin UI/API for creating and managing channel connections
- Execution of external actions after an approval decision
- Complete management UI for agent runs, tasks, and approvals

## Roadmap

- [ ] Complete end-to-end UI/API integration and expand critical-path coverage.
- [ ] Add a secure task/action execution layer with explicit approval enforcement.
- [ ] Build admin screens for channel connections, agent runs, tasks, and approvals.
- [ ] Add reproducible live-model evaluations alongside deterministic CI tests.
- [ ] Verify Auth0 and Telegram in isolated test environments.
- [ ] Add operational metrics, tracing, and production deployment documentation.

## Security notes

- Keep `.env` files and all provider credentials out of Git.
- Never expose client secrets, access tokens, bot tokens, or model API keys in frontend variables.
- Treat tenant IDs as selectors, never as proof of authorization.
- Do not use development auth, fake providers, or test endpoints in production.
- Do not run tests against production or shared databases.
- Review dependency-audit findings before upgrading packages.

## Contributing

Issues, bug reports, and focused pull requests are welcome. For changes to behavior, include tests and update the relevant documentation. Never report a provider integration or evaluation as verified unless it was actually executed.

---

Built as an AI-assisted customer operations platform with a focus on human control, reliable state transitions, and transparent limitations.
