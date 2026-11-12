-- Migration 0001: twin-0.2.0 parameter storage.
--
-- Additive only. Apply after db/schema.sql, the applied baseline, which is never edited in
-- place. Existing trader_twins rows (the baseline-0.1 twins) stay valid: every new column on
-- trader_twins is nullable, and the new checks bind only rows whose model_version starts
-- with "twin-".
--
-- Maps to estimateTwins (src/engine/estimate.mjs):
-- - twin_population_priors: the fit's `priors`, stored once per dataset and model version.
-- - trader_twins: one row per twin, now with its data label, behavior version, prior, and
--   stop-hazard basis. training_window and model_version already exist.
-- - trader_twin_parameters: one row per parameter per twin, with stopHazard stored as one
--   row per drawdown bucket ("stopHazard.down_large").

BEGIN;

CREATE TABLE twin_population_priors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  model_version text NOT NULL,
  behavior_version text NOT NULL,
  data_label text NOT NULL CHECK (data_label IN ('SYNTHETIC', 'OBSERVATIONAL', 'CUSTOMER')),
  training_window tstzrange NOT NULL,
  trader_count integer NOT NULL CHECK (trader_count >= 0),
  -- The behavior-0.2.0 options the fit used (session gap, bucket edges, refuel window).
  behavior_options jsonb NOT NULL,
  -- Per parameter: family (normal on the log scale, beta, inverse-gamma), its
  -- hyperparameters, center, 90% interval, and the number of traders it was fitted on.
  priors jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, model_version)
);

ALTER TABLE trader_twins
  ADD COLUMN data_label text,
  ADD COLUMN behavior_version text,
  ADD COLUMN population_prior_id uuid REFERENCES twin_population_priors(id) ON DELETE CASCADE,
  -- 'voluntary' with balance fields; 'all-cause' (includes running out of money) without.
  ADD COLUMN stop_hazard_basis text,
  ADD CONSTRAINT trader_twins_data_label_check
    CHECK (data_label IS NULL OR data_label IN ('SYNTHETIC', 'OBSERVATIONAL', 'CUSTOMER')),
  ADD CONSTRAINT trader_twins_stop_hazard_basis_check
    CHECK (stop_hazard_basis IS NULL OR stop_hazard_basis IN ('voluntary', 'all-cause')),
  ADD CONSTRAINT trader_twins_twin_fields_check
    CHECK (model_version NOT LIKE 'twin-%'
      OR (data_label IS NOT NULL AND behavior_version IS NOT NULL AND population_prior_id IS NOT NULL));

CREATE TABLE trader_twin_parameters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twin_id uuid NOT NULL REFERENCES trader_twins(id) ON DELETE CASCADE,
  -- A name from TWIN_PARAMETER_NAMES, or stopHazard.<bucket>.
  parameter text NOT NULL,
  status text NOT NULL CHECK (status IN ('estimated', 'prior_only', 'not_estimable')),
  -- Natural scale (currency, minutes, multiplier, or probability).
  estimate numeric,
  interval_lower numeric,
  interval_upper numeric,
  interval_level numeric NOT NULL DEFAULT 0.9 CHECK (interval_level > 0 AND interval_level < 1),
  n integer NOT NULL CHECK (n >= 0),
  -- Weight on the trader's own data: 0 = the prior alone, 1 = no shrinkage.
  shrinkage_weight numeric CHECK (shrinkage_weight >= 0 AND shrinkage_weight <= 1),
  raw_estimate numeric,
  prior_estimate numeric,
  -- Why the parameter is prior_only or not_estimable, or why it has no prior.
  reason text,
  -- Posterior family and hyperparameters, for drawing parameters in simulation.
  posterior jsonb,
  -- Anything else on the record: nLoss and nWin, runs, stops, basis, threshold, fallback.
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (twin_id, parameter),
  CONSTRAINT trader_twin_parameters_not_estimable_check
    CHECK (status <> 'not_estimable' OR (estimate IS NULL AND reason IS NOT NULL)),
  CONSTRAINT trader_twin_parameters_estimate_check
    CHECK (status = 'not_estimable' OR (estimate IS NOT NULL AND shrinkage_weight IS NOT NULL)),
  -- prior_only means weight 0. n can still be 1 for a spread parameter (one value, no spread).
  CONSTRAINT trader_twin_parameters_prior_only_check
    CHECK (status <> 'prior_only' OR shrinkage_weight = 0),
  CONSTRAINT trader_twin_parameters_interval_check
    CHECK ((interval_lower IS NULL) = (interval_upper IS NULL)
      AND (interval_lower IS NULL OR (interval_lower <= estimate AND estimate <= interval_upper)))
);

CREATE INDEX trader_twin_parameters_parameter_idx ON trader_twin_parameters(parameter, status);
CREATE INDEX twin_population_priors_workspace_idx ON twin_population_priors(workspace_id);

COMMIT;
