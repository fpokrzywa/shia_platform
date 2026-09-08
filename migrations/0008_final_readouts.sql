CREATE TABLE workspace_final_readouts (
  id text PRIMARY KEY,
  engagement_id text NOT NULL REFERENCES workspace_engagements(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','approved','rejected')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  source_hash text NOT NULL CHECK (length(source_hash) = 64),
  snapshot jsonb NOT NULL,
  generated_by text NOT NULL REFERENCES app_users(id),
  as_of timestamptz NOT NULL DEFAULT now(),
  reviewed_by text REFERENCES app_users(id),
  reviewed_at timestamptz,
  review_rationale text,
  CHECK ((state = 'draft') = (reviewed_by IS NULL AND reviewed_at IS NULL AND review_rationale IS NULL))
);
CREATE INDEX workspace_final_readouts_engagement_idx ON workspace_final_readouts(engagement_id,as_of DESC,id);

CREATE OR REPLACE FUNCTION protect_final_readout() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND OLD.state = 'draft' AND NEW.state IN ('approved','rejected')
    AND NEW.id = OLD.id AND NEW.engagement_id = OLD.engagement_id
    AND NEW.title = OLD.title AND NEW.source_hash = OLD.source_hash AND NEW.snapshot = OLD.snapshot
    AND NEW.generated_by = OLD.generated_by AND NEW.as_of = OLD.as_of
    AND NEW.revision = OLD.revision + 1
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'final readout snapshots and reviews are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER workspace_final_readouts_immutable BEFORE UPDATE OR DELETE ON workspace_final_readouts FOR EACH ROW EXECUTE FUNCTION protect_final_readout();
