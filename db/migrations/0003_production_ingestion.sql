-- Migration 0003: production upload metadata, ingestion queue controls, and rate limits.
-- Additive only. Raw files stay in private object storage. Postgres stores metadata and
-- normalized events after the ingestion worker validates a file.

BEGIN;

ALTER TABLE datasets
  ADD COLUMN IF NOT EXISTS storage_provider text,
  ADD COLUMN IF NOT EXISTS storage_path text,
  ADD COLUMN IF NOT EXISTS storage_etag text,
  ADD COLUMN IF NOT EXISTS content_type text,
  ADD COLUMN IF NOT EXISTS size_bytes bigint,
  ADD COLUMN IF NOT EXISTS upload_status text NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS retention_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE datasets
  DROP CONSTRAINT IF EXISTS datasets_upload_status_check;

ALTER TABLE datasets
  ADD CONSTRAINT datasets_upload_status_check
  CHECK (upload_status IN ('not_started', 'pending', 'uploaded', 'processing', 'processed', 'failed', 'deleted'));

ALTER TABLE datasets
  DROP CONSTRAINT IF EXISTS datasets_storage_provider_check;

ALTER TABLE datasets
  ADD CONSTRAINT datasets_storage_provider_check
  CHECK (storage_provider IS NULL OR storage_provider IN ('vercel_blob'));

ALTER TABLE ingestion_jobs
  ADD COLUMN IF NOT EXISTS storage_path text,
  ADD COLUMN IF NOT EXISTS content_type text,
  ADD COLUMN IF NOT EXISTS size_bytes bigint,
  ADD COLUMN IF NOT EXISTS source_sha256 text,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS error_message text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS ingestion_jobs_queue_idx
  ON ingestion_jobs(status, created_at);

CREATE INDEX IF NOT EXISTS ingestion_jobs_lease_idx
  ON ingestion_jobs(status, lease_expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS ingestion_jobs_idempotency_idx
  ON ingestion_jobs(dataset_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE analysis_jobs
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS analysis_jobs_idempotency_idx
  ON analysis_jobs(experiment_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS analysis_jobs_lease_idx
  ON analysis_jobs(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket_key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
