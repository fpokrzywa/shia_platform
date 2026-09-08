ALTER TABLE workspace_checklist_instances
  ADD COLUMN owner_user_id text REFERENCES app_users(id),
  ADD COLUMN due_date date,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN completed_by text REFERENCES app_users(id),
  ADD CONSTRAINT workspace_checklist_instances_identity UNIQUE (id, engagement_id);

CREATE TABLE workspace_engagement_notes (
  id text PRIMARY KEY,
  engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE,
  item_id text,
  actor_id text NOT NULL REFERENCES app_users(id),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (item_id, engagement_id) REFERENCES workspace_checklist_instances(id, engagement_id) ON DELETE CASCADE
);
CREATE INDEX workspace_engagement_notes_engagement_idx ON workspace_engagement_notes(engagement_id, created_at, id);
CREATE INDEX workspace_engagement_notes_item_idx ON workspace_engagement_notes(item_id, created_at) WHERE item_id IS NOT NULL;

CREATE TABLE workspace_evidence (
  id text PRIMARY KEY,
  engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE,
  item_id text NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 500),
  url text CHECK (url IS NULL OR length(url) <= 2048),
  file_name text CHECK (file_name IS NULL OR length(file_name) BETWEEN 1 AND 255),
  supplied_media_type text CHECK (supplied_media_type IS NULL OR length(supplied_media_type) BETWEEN 1 AND 255),
  attachment bytea,
  recorded_by text NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (item_id, engagement_id) REFERENCES workspace_checklist_instances(id, engagement_id) ON DELETE CASCADE,
  CHECK ((url IS NOT NULL)::integer + (attachment IS NOT NULL)::integer = 1),
  CHECK (url IS NULL OR url ~ '^https?://'),
  CHECK (attachment IS NULL OR octet_length(attachment) <= 2097152),
  CHECK ((attachment IS NULL) = (file_name IS NULL))
);
CREATE INDEX workspace_evidence_engagement_idx ON workspace_evidence(engagement_id, created_at, id);
CREATE INDEX workspace_evidence_item_idx ON workspace_evidence(item_id, created_at, id);
