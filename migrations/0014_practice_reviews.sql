ALTER TABLE workspace_training_assignments ALTER COLUMN mentor_user_id DROP NOT NULL;
ALTER TABLE workspace_training_assignments ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK(revision>0);

CREATE TABLE workspace_practice_review_references (
  id text PRIMARY KEY,
  training_key text NOT NULL,
  training_version integer NOT NULL,
  reference_version integer NOT NULL CHECK(reference_version>0),
  state text NOT NULL DEFAULT 'draft' CHECK(state IN('draft','published')),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  expected_approach text NOT NULL CHECK(length(btrim(expected_approach)) BETWEEN 1 AND 20000),
  checks jsonb NOT NULL CHECK(jsonb_typeof(checks)='array'),
  pitfalls jsonb NOT NULL CHECK(jsonb_typeof(pitfalls)='array'),
  acceptable_alternatives jsonb NOT NULL CHECK(jsonb_typeof(acceptable_alternatives)='array'),
  rubric jsonb NOT NULL CHECK(jsonb_typeof(rubric)='array'),
  authored_by text NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by text REFERENCES app_users(id), published_at timestamptz, publication_rationale text,
  FOREIGN KEY(training_key,training_version) REFERENCES workspace_training_versions(training_key,version),
  UNIQUE(training_key,training_version,reference_version),
  CHECK((state='published')=(published_by IS NOT NULL AND published_at IS NOT NULL AND publication_rationale IS NOT NULL))
);
CREATE TABLE workspace_practice_comparisons (
  id text PRIMARY KEY, assignment_id text NOT NULL REFERENCES workspace_training_assignments(id) ON DELETE CASCADE,
  reference_id text NOT NULL REFERENCES workspace_practice_review_references(id),
  proposal_id text NOT NULL,
  criteria jsonb NOT NULL CHECK(jsonb_typeof(criteria)='array'), overall_feedback text NOT NULL CHECK(length(btrim(overall_feedback)) BETWEEN 1 AND 10000),
  reviewed_by text NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspace_practice_proposals (
  id text PRIMARY KEY,
  assignment_id text NOT NULL REFERENCES workspace_training_assignments(id) ON DELETE CASCADE,
  proposal_version integer NOT NULL CHECK(proposal_version>0),
  selected_problem text NOT NULL CHECK(length(btrim(selected_problem)) BETWEEN 1 AND 10000),
  rationale text NOT NULL CHECK(length(btrim(rationale)) BETWEEN 1 AND 10000),
  questions jsonb NOT NULL CHECK(jsonb_typeof(questions)='array'),
  proposed_approach text NOT NULL CHECK(length(btrim(proposed_approach)) BETWEEN 1 AND 20000),
  proposed_deliverables jsonb NOT NULL CHECK(jsonb_typeof(proposed_deliverables)='array'),
  success_criteria jsonb NOT NULL CHECK(jsonb_typeof(success_criteria)='array'),
  authored_by text NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(assignment_id,proposal_version), UNIQUE(id,assignment_id)
);
ALTER TABLE workspace_practice_comparisons ADD CONSTRAINT workspace_practice_comparison_proposal_fk
  FOREIGN KEY(proposal_id,assignment_id) REFERENCES workspace_practice_proposals(id,assignment_id);
CREATE INDEX workspace_practice_comparisons_assignment_idx ON workspace_practice_comparisons(assignment_id,created_at DESC,id);
CREATE OR REPLACE FUNCTION protect_practice_review_history() RETURNS trigger AS $$ BEGIN IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF; RAISE EXCEPTION 'published practice reference and comparison history is immutable'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER workspace_practice_reference_immutable BEFORE UPDATE OR DELETE ON workspace_practice_review_references FOR EACH ROW WHEN(OLD.state='published') EXECUTE FUNCTION protect_practice_review_history();
CREATE TRIGGER workspace_practice_comparison_immutable BEFORE UPDATE OR DELETE ON workspace_practice_comparisons FOR EACH ROW EXECUTE FUNCTION protect_practice_review_history();
CREATE TRIGGER workspace_practice_proposal_immutable BEFORE UPDATE OR DELETE ON workspace_practice_proposals FOR EACH ROW EXECUTE FUNCTION protect_practice_review_history();
