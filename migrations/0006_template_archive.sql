ALTER TABLE workspace_templates
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_by text REFERENCES app_users(id),
  ADD COLUMN management_revision bigint NOT NULL DEFAULT 1 CHECK (management_revision > 0);

CREATE INDEX workspace_templates_active_idx
  ON workspace_templates (template_key)
  WHERE archived_at IS NULL;
