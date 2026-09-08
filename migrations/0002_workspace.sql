CREATE TABLE workspace_templates (
  template_key text PRIMARY KEY,
  name text NOT NULL,
  purpose text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_template_versions (
  template_key text NOT NULL REFERENCES workspace_templates(template_key),
  version integer NOT NULL CHECK (version > 0),
  state text NOT NULL CHECK (state IN ('draft', 'published', 'retired')),
  definition jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  source_version integer,
  revision_reason text,
  published_by text REFERENCES app_users(id),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_key, version),
  FOREIGN KEY (template_key, source_version) REFERENCES workspace_template_versions(template_key, version),
  CHECK ((state IN ('published', 'retired')) = (published_by IS NOT NULL AND published_at IS NOT NULL)),
  CHECK (definition ? 'state' AND jsonb_typeof(definition->'state') = 'string' AND definition->>'state' = state),
  CHECK (definition ? 'templateKey' AND jsonb_typeof(definition->'templateKey') = 'string' AND definition->>'templateKey' = template_key),
  CHECK (definition ? 'version' AND jsonb_typeof(definition->'version') = 'number' AND definition->'version' = to_jsonb(version))
);

CREATE OR REPLACE FUNCTION reject_published_template_change() RETURNS trigger AS $$
BEGIN
  IF OLD.state = 'retired' AND (TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'published template versions are immutable';
  END IF;
  IF OLD.state = 'published' AND (TG_OP = 'DELETE' OR NEW.state <> 'retired' OR NEW.definition->>'state' <> 'retired' OR NEW.definition - 'state' IS DISTINCT FROM OLD.definition - 'state' OR NEW.template_key <> OLD.template_key OR NEW.version <> OLD.version OR NEW.source_version IS DISTINCT FROM OLD.source_version OR NEW.revision_reason IS DISTINCT FROM OLD.revision_reason OR NEW.published_by IS DISTINCT FROM OLD.published_by OR NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.revision <> OLD.revision + 1) THEN RAISE EXCEPTION 'published template versions are immutable'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workspace_template_versions_immutable
BEFORE UPDATE OR DELETE ON workspace_template_versions
FOR EACH ROW EXECUTE FUNCTION reject_published_template_change();

CREATE TABLE workspace_clients (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  created_by text NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_engagements (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES workspace_clients(id),
  template_key text NOT NULL,
  template_version integer NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  accountable_lead_user_id text NOT NULL REFERENCES app_users(id),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'active', 'delivery_complete', 'closed', 'cancelled')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by text NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (template_key, template_version) REFERENCES workspace_template_versions(template_key, version)
);
CREATE INDEX workspace_engagements_client_idx ON workspace_engagements(client_id);
CREATE INDEX workspace_engagements_lead_idx ON workspace_engagements(accountable_lead_user_id);

CREATE TABLE workspace_engagement_memberships (
  engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES app_users(id),
  role text NOT NULL CHECK (role IN ('engagement_lead', 'technical_lead', 'engineer', 'reviewer')),
  added_by text NOT NULL REFERENCES app_users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (engagement_id, user_id, role)
);
CREATE INDEX workspace_engagement_memberships_user_idx ON workspace_engagement_memberships(user_id, engagement_id);

CREATE TABLE workspace_stage_instances (
  id text PRIMARY KEY,
  engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE,
  definition_key text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  definition jsonb NOT NULL,
  state text NOT NULL DEFAULT 'not_started' CHECK (state IN ('not_started', 'active', 'awaiting_review', 'complete', 'skipped')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  UNIQUE (engagement_id, definition_key),
  UNIQUE (id, engagement_id)
);
CREATE INDEX workspace_stage_instances_engagement_idx ON workspace_stage_instances(engagement_id, position);

CREATE TABLE workspace_checklist_instances (
  id text PRIMARY KEY,
  engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE,
  stage_id text NOT NULL,
  definition_key text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  definition jsonb NOT NULL,
  status text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'blocked', 'ready_for_review', 'complete', 'not_applicable')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  UNIQUE (engagement_id, definition_key),
  FOREIGN KEY (stage_id, engagement_id) REFERENCES workspace_stage_instances(id, engagement_id) ON DELETE CASCADE
);
CREATE INDEX workspace_checklist_instances_stage_idx ON workspace_checklist_instances(stage_id, position);

CREATE TABLE workspace_action_requests (
  actor_id text NOT NULL REFERENCES app_users(id),
  action text NOT NULL,
  request_key text NOT NULL,
  input_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, action, request_key)
);

CREATE TABLE workspace_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id text NOT NULL REFERENCES app_users(id),
  action text NOT NULL,
  engagement_id text REFERENCES workspace_engagements(id) ON DELETE SET NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_audit_events_engagement_idx ON workspace_audit_events(engagement_id, created_at);
