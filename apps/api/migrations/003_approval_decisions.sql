ALTER TABLE approval_requests
  ADD COLUMN decision_idempotency_key uuid,
  ADD COLUMN decision_request_hash text;

ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check
  CHECK (status IN (
    'queued', 'running', 'waiting_approval', 'approved_not_executed',
    'succeeded', 'failed', 'unknown', 'cancelled'
  ));
