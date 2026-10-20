CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  identity_issuer text NOT NULL,
  identity_subject text NOT NULL,
  display_name text NOT NULL,
  email text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (identity_issuer, identity_subject)
);

CREATE TABLE tenant_memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('agent', 'supervisor', 'tenant_admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE teams (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE team_memberships (
  tenant_id uuid NOT NULL,
  team_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, team_id, user_id),
  FOREIGN KEY (tenant_id, team_id) REFERENCES teams(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE CASCADE
);

CREATE TABLE contacts (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  display_name text NOT NULL,
  email text,
  phone text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE channel_connections (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  channel_type text NOT NULL,
  external_account_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'error')),
  secret_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, channel_type, external_account_id)
);

CREATE TABLE conversations (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  contact_id uuid NOT NULL,
  channel_connection_id uuid NOT NULL,
  control_mode text NOT NULL DEFAULT 'ai' CHECK (control_mode IN ('ai', 'human', 'paused')),
  control_version bigint NOT NULL DEFAULT 0 CHECK (control_version >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high')),
  subject text,
  assigned_user_id uuid,
  assigned_team_id uuid,
  unread_count integer NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id),
  FOREIGN KEY (tenant_id, channel_connection_id)
    REFERENCES channel_connections(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_user_id)
    REFERENCES tenant_memberships(tenant_id, user_id),
  FOREIGN KEY (tenant_id, assigned_team_id)
    REFERENCES teams(tenant_id, id)
);

CREATE TABLE conversation_messages (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  client_message_id uuid,
  external_message_id text,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender_type text NOT NULL CHECK (sender_type IN ('customer', 'agent', 'human', 'system')),
  sender_user_id uuid,
  body text NOT NULL,
  delivery_status text CHECK (
    delivery_status IS NULL OR delivery_status IN
      ('queued', 'sending', 'accepted', 'delivered', 'read', 'failed', 'unknown')
  ),
  control_version bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id),
  FOREIGN KEY (tenant_id, sender_user_id) REFERENCES tenant_memberships(tenant_id, user_id),
  UNIQUE (tenant_id, client_message_id),
  UNIQUE (tenant_id, external_message_id)
);

CREATE TABLE conversation_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system', 'customer')),
  actor_user_id uuid,
  event_type text NOT NULL,
  control_version bigint,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES tenant_memberships(tenant_id, user_id)
);

CREATE TABLE tasks (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  conversation_id uuid,
  task_type text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'unknown', 'cancelled')
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id)
);

CREATE TABLE approval_requests (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  task_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  requested_action jsonb NOT NULL,
  approved_by uuid,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES tenant_memberships(tenant_id, user_id)
);

CREATE TABLE outbox_events (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  event_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'published', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX conversations_inbox_idx
  ON conversations (tenant_id, status, updated_at DESC, id DESC);
CREATE INDEX conversations_assignment_idx
  ON conversations (tenant_id, assigned_user_id, updated_at DESC);
CREATE INDEX conversation_messages_timeline_idx
  ON conversation_messages (tenant_id, conversation_id, created_at DESC, id DESC);
CREATE INDEX conversation_events_stream_idx
  ON conversation_events (tenant_id, id);
CREATE INDEX tasks_conversation_status_idx
  ON tasks (tenant_id, conversation_id, status);
CREATE INDEX approvals_pending_idx
  ON approval_requests (tenant_id, status, created_at DESC);
CREATE INDEX outbox_pending_idx
  ON outbox_events (available_at, created_at)
  WHERE status = 'pending';
