CREATE TABLE workspace_sample_packs (
  pack_key text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('empty', 'loaded')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  generation_id text,
  loaded_by text REFERENCES app_users(id),
  loaded_at timestamptz,
  CHECK ((state = 'loaded') = (generation_id IS NOT NULL AND loaded_by IS NOT NULL AND loaded_at IS NOT NULL))
);

CREATE TABLE workspace_sample_template_versions (
  pack_key text NOT NULL REFERENCES workspace_sample_packs(pack_key),
  template_key text NOT NULL,
  version integer NOT NULL,
  PRIMARY KEY (pack_key, template_key, version),
  FOREIGN KEY (template_key, version) REFERENCES workspace_template_versions(template_key, version)
);

CREATE TABLE workspace_sample_clients (
  pack_key text NOT NULL REFERENCES workspace_sample_packs(pack_key),
  generation_id text NOT NULL,
  client_id text NOT NULL REFERENCES workspace_clients(id),
  PRIMARY KEY (pack_key, generation_id, client_id),
  UNIQUE (client_id)
);

CREATE TABLE workspace_sample_engagements (
  pack_key text NOT NULL REFERENCES workspace_sample_packs(pack_key),
  generation_id text NOT NULL,
  engagement_id text NOT NULL REFERENCES workspace_engagements(id),
  PRIMARY KEY (pack_key, generation_id, engagement_id),
  UNIQUE (engagement_id)
);

CREATE INDEX workspace_sample_clients_generation_idx ON workspace_sample_clients(pack_key, generation_id);
CREATE INDEX workspace_sample_engagements_generation_idx ON workspace_sample_engagements(pack_key, generation_id);
