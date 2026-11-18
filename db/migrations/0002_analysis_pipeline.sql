-- Migration 0002: durable experiment jobs and analysis provenance.
--
-- The worker owns the queued -> running -> succeeded/failed lifecycle. The API only
-- creates a job and reads its result. All additions stay compatible with the baseline
-- schema and the twin-0.2 parameter migration.

BEGIN;

ALTER TABLE datasets
  ADD COLUMN IF NOT EXISTS data_label text NOT NULL DEFAULT 'CUSTOMER';

ALTER TABLE datasets
  DROP CONSTRAINT IF EXISTS datasets_data_label_check;

ALTER TABLE datasets
  ADD CONSTRAINT datasets_data_label_check
  CHECK (data_label IN ('SYNTHETIC', 'OBSERVATIONAL', 'CUSTOMER'));

ALTER TABLE trader_events
  ADD COLUMN IF NOT EXISTS placed_at timestamptz,
  ADD COLUMN IF NOT EXISTS settled_at timestamptz,
  ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS trader_events_dataset_time_idx
  ON trader_events(dataset_id, occurred_at);

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  job_type text NOT NULL CHECK (job_type IN ('experiment_run')),
  status job_status NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  payload jsonb NOT NULL DEFAULT '{}',
  error_message text,
  created_by uuid NOT NULL REFERENCES users(id),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analysis_jobs_queue_idx
  ON analysis_jobs(status, created_at);

CREATE INDEX IF NOT EXISTS analysis_jobs_workspace_idx
  ON analysis_jobs(workspace_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS analysis_jobs_active_experiment_idx
  ON analysis_jobs(experiment_id)
  WHERE status IN ('queued', 'running');

ALTER TABLE experiments
  ADD COLUMN IF NOT EXISTS last_job_id uuid REFERENCES analysis_jobs(id) ON DELETE SET NULL;

COMMIT;
