ALTER TABLE tenant_agent_settings DROP CONSTRAINT tenant_agent_settings_provider_check;
ALTER TABLE tenant_agent_settings
  ADD CONSTRAINT tenant_agent_settings_provider_check
  CHECK (provider IN ('disabled', 'fake', 'openai'));

ALTER TABLE contacts
  ADD COLUMN channel_connection_id uuid,
  ADD COLUMN external_contact_id text,
  ADD CONSTRAINT contacts_channel_connection_fkey
    FOREIGN KEY (tenant_id, channel_connection_id)
    REFERENCES channel_connections(tenant_id, id);

CREATE UNIQUE INDEX contacts_external_channel_identity_idx
  ON contacts (tenant_id, channel_connection_id, external_contact_id)
  WHERE channel_connection_id IS NOT NULL AND external_contact_id IS NOT NULL;

ALTER TABLE conversations
  ADD COLUMN external_conversation_id text;

CREATE UNIQUE INDEX conversations_external_channel_identity_idx
  ON conversations (tenant_id, channel_connection_id, external_conversation_id)
  WHERE external_conversation_id IS NOT NULL;
