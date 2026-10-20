# Feature traceability

This matrix maps the current visible product behavior to its implementation, backend contract, and verification evidence. “Verified” means the named local automated test passed; it does not imply a live provider or production deployment was exercised.

| Feature / UI action | Implementation and API | Evidence | Status and boundary |
|---|---|---|---|
| List, search, filter, and paginate conversations | Inbox in `src/App.tsx`; `GET /v1/conversations`; keyboard shortcut `Control+K` / `⌘K` | Playwright inbox flow; API integration suite | Verified against local PostgreSQL and the local development proxy. Supports filtering by All, Unread, AI (`ردود AI`), Human, and Paused. |
| Read conversation details and timeline | `GET /v1/conversations/:id`, `GET /v1/conversations/:id/timeline` | Playwright selects a test conversation and reloads its history | Verified locally. Message items and audit events are cleanly separated in timeline response. |
| Human takeover, pause, resume, and hand-back | `POST /v1/conversations/:id/takeover`, `pause-ai`, `resume-ai`; expected control version and server-side transaction | Playwright exercises takeover, pause, resume, hand-back; PostgreSQL business flow tests cover stale control and queued send invalidation | Verified locally. Stale AI generations are intercepted before persistence and marked `stale`. |
| Manual reply and delivery status | `POST /v1/conversations/:id/messages` with `Idempotency-Key` and `expectedControlVersion`; `GET /v1/messages/:id` | Playwright sends a reply and sees the test adapter's `accepted` status; PostgreSQL tests cover duplicate requests and stale versions | Verified with the local test adapter. Duplicate requests return `202 Accepted` with existing message and idempotency verification. `accepted` is not proof of external delivery. |
| Assignment and workspace directory | `GET /v1/members`, `GET /v1/teams`, `POST /v1/conversations/:id/assign` | Playwright E2E assignment flow; PostgreSQL integration & business flow suites | Verified in browser UI: selecting a team updates conversation assignee and UI display. Backend validates active tenant membership. |
| Task and approval status | `GET /v1/tasks`, `GET /v1/tasks/:id`, `GET /v1/approvals` | PostgreSQL tests and Playwright approve/reject flow | Pending decisions are supervisor/admin-only. |
| Approve or reject an action | `POST /v1/approvals/:id/decision` with action hash and idempotency key | PostgreSQL tests cover authorization, hash mismatch, replay, and stale conversation context; Playwright covers approve and reject | Verified as a decision record only. No action executor exists; approval records `approved_not_executed` and does not issue external financial refunds or cancel orders. |
| Live updates | Authenticated `GET /v1/events` SSE stream | PostgreSQL test verifies tenant-scoped stream behavior | Verified locally; reconnect/auth state is UI behavior, not a cross-network reliability test. |
| Knowledge add, replace, search, and delete | `GET/POST /v1/knowledge/documents`, `DELETE /v1/knowledge/documents/:id`, `GET /v1/knowledge/search` | PostgreSQL integration, business flow suite, and Playwright lifecycle/search-after-delete | Text/Markdown only; no file upload, OCR, embeddings, or semantic retrieval. Deleted documents are immediately excluded from search results. |
| Authenticated tenant isolation | Auth0 SPA path; server verifies JWT and active membership, with optional tenant selector | PostgreSQL tests use signed test JWTs and membership fixtures; E2E confirms a foreign conversation is not readable (404) through the local proxy | Token verification and authorization logic are tested with local fixtures. Real Auth0 sign-in/logout and a real provider tenant are not verified. |
| OpenAI agent provider | Server-only `OpenAIAgentProvider`; `AGENT_PROVIDER=openai`, tenant setting via `PUT /v1/agent/settings` | Mocked provider contract tests (`apps/api/test/openai-agent-provider.test.ts`) | Adapter parsing, bounded retries, timeout, and sanitized errors are tested. No real credentials, paid calls, model quality, or tenant production run were tested. |
| AI Agent Evaluation Suite (LLM Evals) | Deterministic test runner in `apps/api/test/run-evals.ts` and `dataset.ts`; 14 scenarios across 11 categories | `npm run test:evals` generates `docs/testing/ai-evaluations.json` & `.md` | Covers groundedness, tool selection, prompt injection, hallucination prevention, takeover races, approval enforcement, dialect comprehension, and credential sanitization. 100% critical safety assertions pass. |
| Complete business workflows | `apps/api/test/business-flows.test.ts` | End-to-end flow test suite against PostgreSQL | Verified inbound webhook -> knowledge search -> agent turn -> takeover race -> manual reply -> outbox delivery -> audit trail. |
| Telegram channel | Private-text webhook and outbox adapter | Mocked Telegram adapter tests and PostgreSQL webhook/outbox integration | No real bot, public HTTPS webhook, customer message, receipt, group, or media path has been exercised. API success is recorded as `accepted`, not `delivered`. |
| Login, logout, loading, errors, and retries | `src/Auth0App.tsx`, API client, and inbox states | API auth tests; Playwright runs via local development proxy | Auth0 UI flows are not covered by Playwright. Offline delivery and browser reconnection under network interruption are not end-to-end tested. |
| Overview, customers, settings, channel setup, reports, profile/help/notifications, attachments/templates, customer edits/tags, and secondary menus | Visible controls in `src/App.tsx` | Manual code inspection; controls are disabled with explicit descriptive tooltips and aria-labels | Deliberately unavailable; no successful action is implied. |
| Hard-coded dashboard metrics and profile labels | Presentational values in `src/App.tsx` | Manual code inspection | Illustrative prototype content, not tenant-specific API data. |

## Current repeatable verification

The verification run for this state passed:

- `npm.cmd run build` (Passed production build for Vite and API)
- `npm.cmd run lint` (0 errors, 0 warnings across all source and test files)
- `npm.cmd run typecheck` & `npm.cmd run typecheck:api` (Passed with zero type errors)
- `npm.cmd run test:api` (28 unit and API foundation tests)
- `npm.cmd run test:integration` (11 PostgreSQL integration & business-flow tests)
- `npm.cmd run test:evals` (14 AI Agent evaluation scenarios, 100% critical safety pass)
- `npm.cmd run test:e2e` (Playwright browser test covering inbox, keyboard shortcuts, filters, assignment, takeover, replies, approvals, knowledge, reload, and tenant isolation)
- `npm.cmd audit --omit=dev` (0 production dependency vulnerabilities)
- `npm.cmd run db:migrate` followed by `npm.cmd run db:seed:dev` runs

The tests are local and use mock provider fetches. They do not establish production readiness or verify external credentials.
