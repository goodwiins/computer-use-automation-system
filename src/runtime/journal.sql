CREATE TABLE IF NOT EXISTS meridian_journal_authority (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
  import_id uuid,
  source_digest text,
  owner_id uuid,
  CHECK ((import_id IS NULL) = (source_digest IS NULL)),
  CHECK (source_digest IS NULL OR source_digest ~ '^[a-f0-9]{64}$')
);

CREATE TABLE IF NOT EXISTS meridian_runs (
  run_id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('discovery', 'replay')),
  caller text NOT NULL CHECK (caller ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+,-]{0,199}$'),
  capability text NOT NULL CHECK (capability ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+,-]{0,199}$'),
  version text NOT NULL CHECK (version ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+,-]{0,199}$'),
  request text NOT NULL CHECK (request ~ '^[a-f0-9]{64}$'),
  identity text NOT NULL UNIQUE CHECK (identity ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  state text NOT NULL CHECK (state IN ('reserved', 'running', 'dispatching', 'success', 'business_outcome', 'failure', 'interrupted', 'POST_OUTCOME_UNKNOWN')),
  dispatch_intent boolean NOT NULL DEFAULT false,
  CHECK (state <> 'dispatching' OR dispatch_intent)
);

CREATE TABLE IF NOT EXISTS meridian_run_requests (
  identity text PRIMARY KEY CHECK (identity ~ '^[a-f0-9]{64}$'),
  caller text NOT NULL CHECK (caller ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+,-]{0,199}$'),
  request text NOT NULL CHECK (request ~ '^[a-f0-9]{64}$'),
  run_id uuid NOT NULL REFERENCES meridian_runs (run_id),
  is_alias boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX IF NOT EXISTS meridian_run_requests_direct_run
  ON meridian_run_requests (run_id) WHERE NOT is_alias;

CREATE UNIQUE INDEX IF NOT EXISTS meridian_runs_one_active
  ON meridian_runs ((true))
  WHERE state IN ('reserved', 'running', 'dispatching');

CREATE INDEX IF NOT EXISTS meridian_runs_capability_state
  ON meridian_runs (capability, state);
