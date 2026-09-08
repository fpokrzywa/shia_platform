CREATE TABLE workspace_knowledge_sets (
  knowledge_key text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('recipe','discovery_guide','architecture_pattern')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  created_by text NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  archived_by text REFERENCES app_users(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK ((archived_at IS NULL) = (archived_by IS NULL))
);

CREATE TABLE workspace_knowledge_versions (
  knowledge_key text NOT NULL REFERENCES workspace_knowledge_sets(knowledge_key),
  version integer NOT NULL CHECK (version > 0),
  state text NOT NULL CHECK (state IN ('draft','submitted','published','retired')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  definition jsonb NOT NULL,
  author_id text NOT NULL REFERENCES app_users(id),
  provenance_engagement_id text REFERENCES workspace_engagements(id) ON DELETE SET NULL,
  provenance_type text CHECK (provenance_type IS NULL OR provenance_type IN ('note','learning_log')),
  provenance_id text,
  submitted_at timestamptz,
  submission_rationale text,
  reviewed_by text REFERENCES app_users(id),
  reviewed_at timestamptz,
  review_rationale text,
  retired_by text REFERENCES app_users(id),
  retired_at timestamptz,
  retirement_rationale text,
  PRIMARY KEY (knowledge_key, version),
  CHECK (provenance_engagement_id IS NULL OR provenance_type IS NOT NULL),
  CHECK ((provenance_type IS NULL) = (provenance_id IS NULL)),
  CHECK ((state IN ('submitted','published','retired')) = (submitted_at IS NOT NULL)),
  CHECK ((state IN ('published','retired')) = (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND review_rationale IS NOT NULL)),
  CHECK ((state = 'retired') = (retired_by IS NOT NULL AND retired_at IS NOT NULL AND retirement_rationale IS NOT NULL))
);
CREATE INDEX workspace_knowledge_versions_author_idx ON workspace_knowledge_versions(author_id,state,knowledge_key,version DESC);
CREATE INDEX workspace_knowledge_versions_state_idx ON workspace_knowledge_versions(state,knowledge_key,version DESC);

CREATE TABLE workspace_knowledge_links (
  id text PRIMARY KEY,
  engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE,
  knowledge_key text NOT NULL,
  knowledge_version integer NOT NULL,
  rationale text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 1 AND 5000),
  linked_by text NOT NULL REFERENCES app_users(id),
  linked_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (knowledge_key,knowledge_version) REFERENCES workspace_knowledge_versions(knowledge_key,version),
  UNIQUE (engagement_id,knowledge_key,knowledge_version)
);
CREATE INDEX workspace_knowledge_links_engagement_idx ON workspace_knowledge_links(engagement_id,linked_at,id);

CREATE OR REPLACE FUNCTION protect_knowledge_published_history() RETURNS trigger AS $$ BEGIN
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  IF TG_OP='UPDATE' AND pg_trigger_depth()>1
    AND NEW.definition=OLD.definition AND NEW.state=OLD.state AND NEW.revision=OLD.revision
    AND NEW.provenance_engagement_id IS NULL AND NEW.provenance_type=OLD.provenance_type AND NEW.provenance_id=OLD.provenance_id
  THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.state='published' AND NEW.state='retired'
    AND NEW.knowledge_key=OLD.knowledge_key AND NEW.version=OLD.version
    AND NEW.revision=OLD.revision+1 AND NEW.definition=OLD.definition
    AND NEW.author_id=OLD.author_id AND NEW.provenance_engagement_id IS NOT DISTINCT FROM OLD.provenance_engagement_id
    AND NEW.provenance_type IS NOT DISTINCT FROM OLD.provenance_type AND NEW.provenance_id IS NOT DISTINCT FROM OLD.provenance_id
    AND NEW.submitted_at=OLD.submitted_at AND NEW.submission_rationale=OLD.submission_rationale
    AND NEW.reviewed_by=OLD.reviewed_by AND NEW.reviewed_at=OLD.reviewed_at AND NEW.review_rationale=OLD.review_rationale
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'published knowledge history is immutable';
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER workspace_knowledge_versions_immutable BEFORE UPDATE OR DELETE ON workspace_knowledge_versions
FOR EACH ROW WHEN (OLD.state IN ('published','retired')) EXECUTE FUNCTION protect_knowledge_published_history();
