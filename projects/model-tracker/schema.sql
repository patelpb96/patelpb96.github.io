-- Frontier model tracker: Snowflake DDL. NOT APPLIED YET (see PLAN.md, "Store"; Snowflake comes after
-- the schema settles). The seed CSVs in seed/ use the same column names, so the move is a load.
--
-- Rules for every *_obs table:
--   * Append-only. Rows are inserted, never updated or deleted. A correction inserts a new row whose
--     `supersedes` names the old obs_id.
--   * `reported_date` = the date the source says the number applies to; `observed_at` = when we saw it.
--     "As of date D" = the latest row per key with observed_at <= D.
--   * A missing number is NULL with status = 'not_observed'; it is never the string "not observed".
--   * `origin` is 'scraped' (the pipeline) or 'manual' (a custom entry made on request).
-- Snowflake does not enforce PRIMARY KEY, UNIQUE or CHECK; build_snapshot.py enforces them on the seed
-- and the pipeline must enforce them on load.

CREATE SCHEMA IF NOT EXISTS MODEL_TRACKER;
USE SCHEMA MODEL_TRACKER;

-- Search side -------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS SEARCH_PARAM (
  param_id        VARCHAR NOT NULL,          -- referenced everywhere instead of the full phrase
  lang            VARCHAR NOT NULL,          -- 'en' | 'zh'
  concept_id      VARCHAR NOT NULL,          -- shared concept list; pairs zh and en phrases
  phrase_sha256   VARCHAR NOT NULL,
  gloss_en        VARCHAR,                   -- English gloss; required for any non-ASCII phrase
  argon_verdict   VARCHAR,                   -- 'approved' | 'rejected' | NULL
  status          VARCHAR NOT NULL,          -- 'draft' | 'approved' | 'retired'
  created_at      TIMESTAMP_NTZ NOT NULL,
  PRIMARY KEY (param_id)
);

CREATE TABLE IF NOT EXISTS SEARCH_RUN (
  run_id          VARCHAR NOT NULL,
  slot            VARCHAR NOT NULL,          -- e.g. '2026-11-06T02' (date + slot; also the S3 lock key)
  started_at      TIMESTAMP_NTZ NOT NULL,
  mode            VARCHAR NOT NULL,          -- 'explore' | 'exploit' | 'sweep'
  exa_calls       NUMBER(4,0) NOT NULL,
  cost_usd        NUMBER(8,4),
  window_start    TIMESTAMP_NTZ NOT NULL,
  window_end      TIMESTAMP_NTZ NOT NULL,
  PRIMARY KEY (run_id)
);

CREATE TABLE IF NOT EXISTS HIT (
  hit_id          VARCHAR NOT NULL,
  run_id          VARCHAR NOT NULL,
  param_id        VARCHAR NOT NULL,
  url_hash        VARCHAR NOT NULL,          -- sha256 of the canonical URL; dedupe key across overlapping windows
  url             VARCHAR NOT NULL,
  domain          VARCHAR NOT NULL,
  published_at    TIMESTAMP_NTZ,
  verdict         VARCHAR NOT NULL,          -- 'release' | 'not_release' | 'unsure'
  verdict_prob    FLOAT,
  injection_flag  BOOLEAN NOT NULL DEFAULT FALSE,   -- quarantined by the Jev injection screen
  PRIMARY KEY (hit_id)
);

CREATE TABLE IF NOT EXISTS SOURCE (
  domain          VARCHAR NOT NULL,
  class           VARCHAR NOT NULL,          -- 'detector' | 'truth' | 'aggregator'
  status          VARCHAR NOT NULL,          -- 'candidate' | 'whitelisted' | 'demoted'
  extractor_kind  VARCHAR,                   -- 'json_ld' | 'css' | 'regex' | 'agent'
  precision_est   FLOAT,
  lead_hours      FLOAT,                     -- median hours between the first report of a release and this source's
  updated_at      TIMESTAMP_NTZ NOT NULL,
  PRIMARY KEY (domain)
);

-- Entities ----------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS MODEL (
  model_id        VARCHAR NOT NULL,          -- slug: 'anthropic/claude-opus-5-5'
  org             VARCHAR NOT NULL,
  family          VARCHAR NOT NULL,
  version_label   VARCHAR NOT NULL,          -- a string, never a float: 'Opus 5.5', 'R1-0528'
  display_name    VARCHAR NOT NULL,
  class           VARCHAR,                   -- 'proprietary' | 'open_weights'
  open_weights    BOOLEAN,
  release_date    DATE,                      -- NULL = not observed
  origin          VARCHAR NOT NULL,
  PRIMARY KEY (model_id)
);

CREATE TABLE IF NOT EXISTS BENCHMARK (
  benchmark_id    VARCHAR NOT NULL,
  name            VARCHAR NOT NULL,
  version         VARCHAR,                   -- e.g. 'Verified' vs 'Pro'; NULL = not observed
  category        VARCHAR,
  blurb           VARCHAR,                   -- short "what this test means"
  higher_is_better BOOLEAN NOT NULL,
  unit            VARCHAR,
  PRIMARY KEY (benchmark_id)
);

-- Observations (append-only) ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS SCORE_OBS (
  obs_id          VARCHAR NOT NULL,
  model_id        VARCHAR NOT NULL,
  benchmark_id    VARCHAR NOT NULL,
  value           FLOAT,                     -- NULL iff status = 'not_observed'
  status          VARCHAR NOT NULL,          -- 'observed' | 'not_observed'
  reported_date   DATE,
  observed_at     TIMESTAMP_NTZ NOT NULL,
  effort          VARCHAR,                   -- thinking / reasoning setting, e.g. 'High', 'Max'
  shots           VARCHAR,
  tools           VARCHAR,
  provenance      VARCHAR NOT NULL,          -- 'self_reported' | 'third_party' | 'third_party_aggregator' | 'community' | 'manual_entry'
  source_hit_id   VARCHAR,                   -- HIT.hit_id when scraped
  source_name     VARCHAR,
  source_url      VARCHAR,
  extraction_method VARCHAR,                 -- 'in_text' | 'parser' | 'agent' | 'manual'
  confidence      FLOAT,
  supersedes      VARCHAR,                   -- obs_id this row corrects
  origin          VARCHAR NOT NULL,
  PRIMARY KEY (obs_id)
);

CREATE TABLE IF NOT EXISTS PRICE_OBS (
  obs_id          VARCHAR NOT NULL,
  model_id        VARCHAR NOT NULL,
  provider        VARCHAR NOT NULL,          -- price belongs to model + provider, not to a benchmark row
  input_per_1m    FLOAT,                     -- USD per 1M tokens; NULL = not observed
  output_per_1m   FLOAT,
  cached_input_per_1m FLOAT,
  blended_3to1_per_1m FLOAT,                 -- (3 * input + output) / 4, when only a blend is published
  reported_date   DATE,
  observed_at     TIMESTAMP_NTZ NOT NULL,
  provenance      VARCHAR NOT NULL,
  source_name     VARCHAR,
  source_url      VARCHAR,
  supersedes      VARCHAR,
  origin          VARCHAR NOT NULL,
  PRIMARY KEY (obs_id)
);

CREATE TABLE IF NOT EXISTS SPEED_OBS (
  obs_id          VARCHAR NOT NULL,
  model_id        VARCHAR NOT NULL,
  provider        VARCHAR NOT NULL,
  tok_per_s       NUMBER(8,1),               -- median output tokens per second; NULL = not observed
  reported_date   DATE,
  observed_at     TIMESTAMP_NTZ NOT NULL,
  provenance      VARCHAR NOT NULL,
  source_name     VARCHAR,
  source_url      VARCHAR,
  supersedes      VARCHAR,
  origin          VARCHAR NOT NULL,
  PRIMARY KEY (obs_id)
);

-- Judgements --------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS EVENT (
  event_id        VARCHAR NOT NULL,
  model_id        VARCHAR NOT NULL,
  benchmark_id    VARCHAR,
  rule_version    VARCHAR NOT NULL,          -- the noteworthy rule is code; its version is stored with every event
  margin          FLOAT,
  beat_model_id   VARCHAR,
  reason          VARCHAR NOT NULL,
  created_at      TIMESTAMP_NTZ NOT NULL,
  PRIMARY KEY (event_id)
);
