CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE member_role AS ENUM ('owner', 'analyst', 'reviewer', 'viewer');
CREATE TYPE dataset_status AS ENUM ('uploaded', 'validating', 'ready', 'rejected', 'archived');
CREATE TYPE event_type AS ENUM ('trade', 'deposit', 'withdrawal', 'balance_snapshot', 'policy_event', 'restriction_event', 'self_exclusion_event');
CREATE TYPE job_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');
CREATE TYPE experiment_status AS ENUM ('draft', 'queued', 'running', 'succeeded', 'failed', 'approved', 'rejected');
CREATE TYPE onboarding_task_status AS ENUM ('pending', 'in_progress', 'done', 'blocked');
CREATE TYPE connection_mode AS ENUM ('read_only', 'disabled');

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  venue_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_subject text UNIQUE NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role member_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  source_filename text NOT NULL,
  source_sha256 text NOT NULL,
  schema_version text NOT NULL,
  status dataset_status NOT NULL DEFAULT 'uploaded',
  is_synthetic boolean NOT NULL DEFAULT false,
  row_count integer,
  trader_count integer,
  starts_at timestamptz,
  ends_at timestamptz,
  quality_report jsonb,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trader_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  trader_token text NOT NULL,
  occurred_at timestamptz NOT NULL,
  type event_type NOT NULL,
  venue_id text NOT NULL,
  market_id text,
  market_type text,
  side text,
  price numeric,
  quantity numeric,
  stake_amount numeric,
  payout_amount numeric,
  deposit_amount numeric,
  withdrawal_amount numeric,
  balance_before numeric,
  balance_after numeric,
  policy_event_type text,
  policy_event_value text,
  realized_result numeric,
  source_row_number integer NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, event_id)
);

CREATE INDEX trader_events_workspace_time_idx ON trader_events(workspace_id, occurred_at);
CREATE INDEX trader_events_dataset_trader_idx ON trader_events(dataset_id, trader_token);

CREATE TABLE signal_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  version text NOT NULL,
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

CREATE TABLE signal_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  signal_definition_id uuid NOT NULL REFERENCES signal_definitions(id),
  status job_status NOT NULL DEFAULT 'queued',
  coverage jsonb,
  results jsonb,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trader_twins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  trader_token text NOT NULL,
  model_name text NOT NULL,
  model_version text NOT NULL,
  random_seed bigint NOT NULL,
  training_window tstzrange NOT NULL,
  validation_window tstzrange,
  profile jsonb NOT NULL,
  validation jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, trader_token, model_version)
);

CREATE TABLE policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  version text NOT NULL,
  policy_type text NOT NULL,
  configuration jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name, version)
);

CREATE TABLE experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  policy_id uuid NOT NULL REFERENCES policies(id),
  name text NOT NULL,
  status experiment_status NOT NULL DEFAULT 'draft',
  random_seed bigint NOT NULL,
  horizon_days integer NOT NULL,
  assumptions jsonb NOT NULL DEFAULT '{}',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE experiment_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  scenario text NOT NULL,
  metrics jsonb NOT NULL,
  coverage jsonb NOT NULL DEFAULT '{}',
  limitations jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, scenario)
);

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  version text NOT NULL,
  report_json jsonb NOT NULL,
  artifact_key text,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, version)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  request_id text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_workspace_time_idx ON audit_events(workspace_id, created_at);

CREATE TABLE onboarding_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_key text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  status onboarding_task_status NOT NULL DEFAULT 'pending',
  sort_order integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}',
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, task_key)
);

CREATE TABLE venue_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  venue_id text NOT NULL,
  display_name text NOT NULL,
  mode connection_mode NOT NULL DEFAULT 'disabled',
  capabilities jsonb NOT NULL DEFAULT '[]',
  credential_ref text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, venue_id)
);

CREATE TABLE ingestion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  source_kind text NOT NULL,
  source_filename text NOT NULL,
  status job_status NOT NULL DEFAULT 'queued',
  row_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]',
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX onboarding_tasks_workspace_order_idx ON onboarding_tasks(workspace_id, sort_order);
CREATE INDEX venue_connections_workspace_idx ON venue_connections(workspace_id);
CREATE INDEX ingestion_jobs_workspace_time_idx ON ingestion_jobs(workspace_id, created_at);
