ALTER TABLE channel_connections
  ADD COLUMN capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN configuration_status text NOT NULL DEFAULT 'not_configured'
    CHECK (configuration_status IN ('not_configured', 'ready', 'error')),
  ADD COLUMN last_checked_at timestamptz,
  ADD COLUMN last_error_code text;

ALTER TABLE outbox_events
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN last_error_code text;

ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_status_check;
ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_status_check
  CHECK (status IN ('pending', 'processing', 'published', 'failed', 'unknown'));

CREATE INDEX outbox_expired_lease_idx
  ON outbox_events (lease_expires_at)
  WHERE status = 'processing';

CREATE TABLE channel_webhook_events (
  tenant_id uuid NOT NULL,
  channel_connection_id uuid NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (tenant_id, channel_connection_id, provider_event_id),
  FOREIGN KEY (tenant_id, channel_connection_id)
    REFERENCES channel_connections(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE knowledge_documents (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  source_key text NOT NULL,
  source_name text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  content_sha256 text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('text/plain', 'text/markdown')),
  status text NOT NULL CHECK (status IN ('active', 'replaced', 'deleted', 'failed')),
  ingestion_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source_key, version)
);

CREATE UNIQUE INDEX knowledge_one_active_source_idx
  ON knowledge_documents (tenant_id, source_key)
  WHERE status = 'active';

CREATE TABLE knowledge_chunks (
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  document_version integer NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id, document_version, ordinal),
  FOREIGN KEY (tenant_id, document_id)
    REFERENCES knowledge_documents(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX knowledge_chunks_document_idx
  ON knowledge_chunks (tenant_id, document_id, document_version);

CREATE TABLE tenant_agent_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  provider text NOT NULL DEFAULT 'disabled'
    CHECK (provider IN ('disabled', 'fake')),
  system_instructions text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_runs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  trigger_message_id uuid,
  provider text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'stale')),
  control_version bigint NOT NULL,
  decision_type text,
  prompt_tokens integer,
  completion_tokens integer,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX agent_runs_conversation_idx
  ON agent_runs (tenant_id, conversation_id, created_at DESC);

CREATE UNIQUE INDEX agent_runs_trigger_message_idx
  ON agent_runs (tenant_id, trigger_message_id)
  WHERE trigger_message_id IS NOT NULL AND status <> 'failed';

CREATE TABLE agent_tool_calls (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  agent_run_id uuid NOT NULL,
  tool_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('succeeded', 'failed', 'denied', 'waiting_approval')),
  input_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, agent_run_id)
    REFERENCES agent_runs(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE approval_requests
  ADD COLUMN action_hash text,
  ADD COLUMN control_version bigint;
