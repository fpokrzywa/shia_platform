ALTER TABLE workspace_evidence
  ADD COLUMN evidence_requirement_key text CHECK (evidence_requirement_key IS NULL OR length(btrim(evidence_requirement_key)) BETWEEN 1 AND 200);
CREATE INDEX workspace_evidence_requirement_idx ON workspace_evidence(item_id, evidence_requirement_key) WHERE evidence_requirement_key IS NOT NULL;

CREATE TABLE workspace_readiness_decisions (
  id text PRIMARY KEY,
  engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE,
  stage_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('go', 'conditional_go', 'no_go', 'reopen')),
  rationale text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 1 AND 10000),
  snapshot_token text NOT NULL,
  snapshot jsonb NOT NULL,
  actor_id text NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (stage_id, engagement_id) REFERENCES workspace_stage_instances(id, engagement_id) ON DELETE CASCADE
);
CREATE INDEX workspace_readiness_decisions_stage_idx ON workspace_readiness_decisions(stage_id, created_at DESC, id DESC);

CREATE TABLE workspace_readiness_exceptions (
  id text PRIMARY KEY,
  decision_id text NOT NULL REFERENCES workspace_readiness_decisions(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES workspace_checklist_instances(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES app_users(id),
  due_date date NOT NULL,
  rationale text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 1 AND 10000),
  UNIQUE (decision_id, item_id)
);
CREATE INDEX workspace_readiness_exceptions_decision_idx ON workspace_readiness_exceptions(decision_id);

CREATE TABLE workspace_not_applicable_reviews (
  id text PRIMARY KEY,
  engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE,
  item_id text NOT NULL,
  item_revision bigint NOT NULL CHECK (item_revision > 0),
  snapshot_token text NOT NULL,
  rationale text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 1 AND 10000),
  actor_id text NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (item_id, engagement_id) REFERENCES workspace_checklist_instances(id, engagement_id) ON DELETE CASCADE
);
CREATE INDEX workspace_not_applicable_reviews_item_idx ON workspace_not_applicable_reviews(item_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION reject_readiness_history_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'readiness history is immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER workspace_readiness_decisions_immutable BEFORE UPDATE OR DELETE ON workspace_readiness_decisions FOR EACH ROW EXECUTE FUNCTION reject_readiness_history_change();
CREATE TRIGGER workspace_readiness_exceptions_immutable BEFORE UPDATE OR DELETE ON workspace_readiness_exceptions FOR EACH ROW EXECUTE FUNCTION reject_readiness_history_change();
CREATE TRIGGER workspace_not_applicable_reviews_immutable BEFORE UPDATE OR DELETE ON workspace_not_applicable_reviews FOR EACH ROW EXECUTE FUNCTION reject_readiness_history_change();
