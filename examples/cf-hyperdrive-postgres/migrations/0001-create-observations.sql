-- Observations table — the agent writes one row per cron tick
-- summarizing what it saw in pg_stat_statements. Rows drive the
-- confidence calculation in `InsightFeedback` (more consecutive
-- observations of the same slow query → higher confidence).
--
-- Run once against your target database:
--   psql "$DATABASE_URL" < migrations/0001-create-observations.sql

CREATE TABLE IF NOT EXISTS meridian_observations (
  id           BIGSERIAL    PRIMARY KEY,
  observed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  queryid      BIGINT       NOT NULL,
  query_text   TEXT         NOT NULL,
  calls        BIGINT       NOT NULL,
  mean_ms      DOUBLE PRECISION NOT NULL,
  p95_ms       DOUBLE PRECISION,
  total_ms     DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meridian_obs_queryid_time
  ON meridian_observations (queryid, observed_at DESC);

-- pg_stat_statements needs to be loaded at server startup:
--   shared_preload_libraries = 'pg_stat_statements'
-- Then enable in the target database:
--   CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
-- The agent ONLY reads from pg_stat_statements; it doesn't need
-- write privileges on anything beyond meridian_observations.
