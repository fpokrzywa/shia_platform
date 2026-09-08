CREATE TABLE workspace_discovery_sessions (
 id text PRIMARY KEY, engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE,
 purpose text NOT NULL CHECK(length(btrim(purpose)) BETWEEN 1 AND 5000), session_date date NOT NULL,
 participant_user_ids jsonb NOT NULL CHECK(jsonb_typeof(participant_user_ids)='array'), summary text NOT NULL CHECK(length(btrim(summary)) BETWEEN 1 AND 20000),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), created_by text NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_discovery_sessions_engagement_idx ON workspace_discovery_sessions(engagement_id,session_date DESC,id);
CREATE TABLE workspace_discovery_use_cases (
 id text PRIMARY KEY, engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE,
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 300), problem_statement text NOT NULL CHECK(length(btrim(problem_statement)) BETWEEN 1 AND 10000),
 actor_description text NOT NULL CHECK(length(btrim(actor_description)) BETWEEN 1 AND 2000), desired_outcome text NOT NULL CHECK(length(btrim(desired_outcome)) BETWEEN 1 AND 10000),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), created_by text NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_discovery_use_cases_engagement_idx ON workspace_discovery_use_cases(engagement_id,created_at,id);
CREATE TABLE workspace_discovery_assumptions (
 id text PRIMARY KEY, engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE,
 statement text NOT NULL CHECK(length(btrim(statement)) BETWEEN 1 AND 10000), status text NOT NULL CHECK(status IN('open','validated','invalidated')), rationale text CHECK(rationale IS NULL OR length(btrim(rationale)) BETWEEN 1 AND 10000),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), created_by text NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_discovery_assumptions_engagement_idx ON workspace_discovery_assumptions(engagement_id,status,id);
CREATE TABLE workspace_discovery_approaches (
 id text PRIMARY KEY, engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE,
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 300), description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 20000), status text NOT NULL CHECK(status IN('considered','selected','rejected')),
 rationale text CHECK(rationale IS NULL OR length(btrim(rationale)) BETWEEN 1 AND 10000), effort_value numeric CHECK(effort_value IS NULL OR effort_value>=0), effort_unit text CHECK(effort_unit IS NULL OR length(btrim(effort_unit)) BETWEEN 1 AND 100),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), created_by text NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CHECK((effort_value IS NULL)=(effort_unit IS NULL))
);
CREATE INDEX workspace_discovery_approaches_engagement_idx ON workspace_discovery_approaches(engagement_id,status,id);
CREATE TABLE workspace_discovery_scope_links (
 engagement_id text PRIMARY KEY REFERENCES workspace_engagements(id) ON DELETE CASCADE,
 scope_id text NOT NULL REFERENCES workspace_scope_versions(id) ON DELETE CASCADE,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), linked_by text NOT NULL REFERENCES app_users(id), linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspace_outcome_metrics (
 id text PRIMARY KEY, engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 300), unit text NOT NULL CHECK(length(btrim(unit)) BETWEEN 1 AND 100), description text CHECK(description IS NULL OR length(btrim(description)) BETWEEN 1 AND 5000),
 baseline numeric, target numeric, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), created_by text NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,engagement_id)
);
CREATE INDEX workspace_outcome_metrics_engagement_idx ON workspace_outcome_metrics(engagement_id,created_at,id);
CREATE TABLE workspace_outcome_observations (
 id text PRIMARY KEY, engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE,
 metric_id text NOT NULL, observed_on date NOT NULL, value numeric NOT NULL, note text CHECK(note IS NULL OR length(btrim(note)) BETWEEN 1 AND 10000), evidence_id text REFERENCES workspace_evidence(id) ON DELETE SET NULL,
 recorded_by text NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(metric_id,engagement_id) REFERENCES workspace_outcome_metrics(id,engagement_id) ON DELETE CASCADE
);
CREATE INDEX workspace_outcome_observations_metric_idx ON workspace_outcome_observations(metric_id,observed_on DESC,id DESC);
CREATE OR REPLACE FUNCTION reject_outcome_observation_change() RETURNS trigger AS $$ BEGIN IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF; RAISE EXCEPTION 'outcome observations are immutable'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER workspace_outcome_observations_immutable BEFORE UPDATE OR DELETE ON workspace_outcome_observations FOR EACH ROW EXECUTE FUNCTION reject_outcome_observation_change();
