CREATE TABLE workspace_training_sets (
  training_key text PRIMARY KEY,
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 300),
  purpose text NOT NULL CHECK(length(btrim(purpose)) BETWEEN 1 AND 5000),
  created_by text NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspace_training_versions (
  training_key text NOT NULL REFERENCES workspace_training_sets(training_key),
  version integer NOT NULL CHECK(version>0), state text NOT NULL CHECK(state IN('draft','published','retired')),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), definition jsonb NOT NULL,
  source_version integer, revision_reason text, published_by text REFERENCES app_users(id), published_at timestamptz,
  PRIMARY KEY(training_key,version), FOREIGN KEY(training_key,source_version) REFERENCES workspace_training_versions(training_key,version),
  CHECK((state='published')=(published_by IS NOT NULL AND published_at IS NOT NULL))
);
CREATE TABLE workspace_training_assignments (
  id text PRIMARY KEY, training_key text NOT NULL, training_version integer NOT NULL,
  learner_user_id text NOT NULL REFERENCES app_users(id), mentor_user_id text NOT NULL REFERENCES app_users(id),
  engagement_id text REFERENCES workspace_engagements(id) ON DELETE CASCADE,
  assessment_revision bigint NOT NULL DEFAULT 0 CHECK(assessment_revision>=0), assigned_by text NOT NULL REFERENCES app_users(id), assigned_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(training_key,training_version) REFERENCES workspace_training_versions(training_key,version), CHECK(learner_user_id<>mentor_user_id)
);
CREATE INDEX workspace_training_assignments_learner_idx ON workspace_training_assignments(learner_user_id,assigned_at DESC);
CREATE INDEX workspace_training_assignments_mentor_idx ON workspace_training_assignments(mentor_user_id,assigned_at DESC);
CREATE INDEX workspace_training_assignments_engagement_idx ON workspace_training_assignments(engagement_id) WHERE engagement_id IS NOT NULL;
CREATE TABLE workspace_training_evidence (
  id text PRIMARY KEY, assignment_id text NOT NULL REFERENCES workspace_training_assignments(id) ON DELETE CASCADE,
  item_key text, title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 300), source_date date,
  url text CHECK(url IS NULL OR (url ~ '^https?://' AND length(url)<=2048)), file_name text CHECK(file_name IS NULL OR length(file_name) BETWEEN 1 AND 255), supplied_media_type text, attachment bytea,
  recorded_by text NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((url IS NOT NULL)::integer+(attachment IS NOT NULL)::integer=1), CHECK(attachment IS NULL OR octet_length(attachment)<=2097152), CHECK((attachment IS NULL)=(file_name IS NULL))
);
CREATE INDEX workspace_training_evidence_assignment_idx ON workspace_training_evidence(assignment_id,created_at,id);
CREATE TABLE workspace_training_progress (
  assignment_id text NOT NULL REFERENCES workspace_training_assignments(id) ON DELETE CASCADE, item_key text NOT NULL,
  status text NOT NULL DEFAULT 'not_started' CHECK(status IN('not_started','in_progress','complete')), revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  training_evidence_id text REFERENCES workspace_training_evidence(id) ON DELETE SET NULL, engagement_evidence_id text REFERENCES workspace_evidence(id) ON DELETE SET NULL, updated_by text NOT NULL REFERENCES app_users(id), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(assignment_id,item_key)
);
CREATE TABLE workspace_learning_logs (
  id text PRIMARY KEY, assignment_id text NOT NULL REFERENCES workspace_training_assignments(id) ON DELETE CASCADE,
  item_key text, body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 10000), training_evidence_id text REFERENCES workspace_training_evidence(id) ON DELETE SET NULL, engagement_evidence_id text REFERENCES workspace_evidence(id) ON DELETE SET NULL,
  actor_id text NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_learning_logs_assignment_idx ON workspace_learning_logs(assignment_id,created_at,id);
CREATE TABLE workspace_mentor_assessments (
  id text PRIMARY KEY, assignment_id text NOT NULL REFERENCES workspace_training_assignments(id) ON DELETE CASCADE,
  assessment_revision bigint NOT NULL CHECK(assessment_revision>0), result text NOT NULL CHECK(result IN('competent','needs_development')),
  rationale text NOT NULL CHECK(length(btrim(rationale)) BETWEEN 1 AND 10000), snapshot_token text NOT NULL, actor_id text NOT NULL REFERENCES app_users(id), admin_override boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(assignment_id,assessment_revision)
);
CREATE INDEX workspace_mentor_assessments_assignment_idx ON workspace_mentor_assessments(assignment_id,assessment_revision DESC);

CREATE OR REPLACE FUNCTION protect_training_history() RETURNS trigger AS $$ BEGIN
 IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'published training and assessment history is immutable'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER workspace_training_versions_immutable BEFORE UPDATE OR DELETE ON workspace_training_versions FOR EACH ROW WHEN (OLD.state='published') EXECUTE FUNCTION protect_training_history();
CREATE TRIGGER workspace_mentor_assessments_immutable BEFORE UPDATE OR DELETE ON workspace_mentor_assessments FOR EACH ROW EXECUTE FUNCTION protect_training_history();
