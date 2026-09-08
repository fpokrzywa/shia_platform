CREATE TABLE operational_maintenance_events (
  id text PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN ('session_cleanup')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operational_maintenance_events_created_idx ON operational_maintenance_events(created_at DESC);
