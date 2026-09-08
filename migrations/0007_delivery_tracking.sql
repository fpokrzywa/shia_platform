CREATE TABLE workspace_scope_versions (
 id text PRIMARY KEY, engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE,
 version integer NOT NULL CHECK(version>0), state text NOT NULL CHECK(state IN('proposed','accepted','rejected')),
 commitments jsonb NOT NULL, exclusions jsonb NOT NULL, estimate text NOT NULL, acceptance_criteria jsonb NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), proposed_by text NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 decided_by text REFERENCES app_users(id), decided_at timestamptz, decision_rationale text, evidence_id text REFERENCES workspace_evidence(id),
 UNIQUE(engagement_id,version), CHECK((state='proposed')=(decided_by IS NULL AND decided_at IS NULL AND decision_rationale IS NULL))
);
CREATE INDEX workspace_scope_versions_engagement_idx ON workspace_scope_versions(engagement_id,version DESC);

CREATE TABLE workspace_delivery_milestones (
 id text PRIMARY KEY, engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE, title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 300),
 status text NOT NULL CHECK(status IN('planned','in_progress','complete','cancelled')), owner_user_id text REFERENCES app_users(id), due_date date, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), created_by text NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_delivery_milestones_engagement_idx ON workspace_delivery_milestones(engagement_id,due_date,id);
CREATE TABLE workspace_delivery_risks (
 id text PRIMARY KEY, engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE, title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 300), severity text NOT NULL CHECK(severity IN('low','medium','high','critical')), status text NOT NULL DEFAULT 'open' CHECK(status IN('open','mitigated','accepted','closed')), mitigation text NOT NULL CHECK(length(btrim(mitigation)) BETWEEN 1 AND 10000), owner_user_id text REFERENCES app_users(id), revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), created_by text NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_delivery_risks_engagement_idx ON workspace_delivery_risks(engagement_id,status,severity,id);
CREATE TABLE workspace_delivery_decisions (
 id text PRIMARY KEY, engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE, title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 300), decision text NOT NULL CHECK(length(btrim(decision)) BETWEEN 1 AND 10000), rationale text NOT NULL CHECK(length(btrim(rationale)) BETWEEN 1 AND 10000), actor_id text NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_delivery_decisions_engagement_idx ON workspace_delivery_decisions(engagement_id,created_at DESC,id);
CREATE TABLE workspace_deliverables (
 id text PRIMARY KEY, engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE, title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 300), description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 10000), status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','ready','handed_over')), revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), created_by text NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,engagement_id)
);
CREATE INDEX workspace_deliverables_engagement_idx ON workspace_deliverables(engagement_id,status,id);
CREATE TABLE workspace_acceptance_records (
 id text PRIMARY KEY, engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE, deliverable_id text, result text NOT NULL CHECK(result IN('accepted','rejected','partial')), rationale text NOT NULL CHECK(length(btrim(rationale)) BETWEEN 1 AND 10000), source_type text NOT NULL CHECK(source_type IN('internal','external')), external_name text, evidence_id text REFERENCES workspace_evidence(id), actor_id text NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(deliverable_id,engagement_id) REFERENCES workspace_deliverables(id,engagement_id) ON DELETE CASCADE, CHECK((source_type='external')=(external_name IS NOT NULL))
);
CREATE INDEX workspace_acceptance_engagement_idx ON workspace_acceptance_records(engagement_id,created_at DESC,id);
CREATE TABLE workspace_delivery_followups (
 id text PRIMARY KEY, engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE, title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 300), status text NOT NULL DEFAULT 'open' CHECK(status IN('open','complete','cancelled')), owner_user_id text REFERENCES app_users(id), due_date date, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), created_by text NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_delivery_followups_engagement_idx ON workspace_delivery_followups(engagement_id,status,due_date,id);

CREATE OR REPLACE FUNCTION reject_delivery_history_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'delivery history is immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER workspace_delivery_decisions_immutable BEFORE UPDATE OR DELETE ON workspace_delivery_decisions FOR EACH ROW EXECUTE FUNCTION reject_delivery_history_change();
CREATE TRIGGER workspace_acceptance_records_immutable BEFORE UPDATE OR DELETE ON workspace_acceptance_records FOR EACH ROW EXECUTE FUNCTION reject_delivery_history_change();

CREATE OR REPLACE FUNCTION protect_scope_version() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND OLD.state = 'proposed' AND NEW.state IN ('accepted','rejected')
    AND NEW.id = OLD.id AND NEW.engagement_id = OLD.engagement_id AND NEW.version = OLD.version
    AND NEW.commitments = OLD.commitments AND NEW.exclusions = OLD.exclusions
    AND NEW.estimate = OLD.estimate AND NEW.acceptance_criteria = OLD.acceptance_criteria
    AND NEW.proposed_by = OLD.proposed_by AND NEW.created_at = OLD.created_at
    AND NEW.revision = OLD.revision + 1
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'scope version content and decisions are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER workspace_scope_versions_immutable BEFORE UPDATE OR DELETE ON workspace_scope_versions FOR EACH ROW EXECUTE FUNCTION protect_scope_version();
