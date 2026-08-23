/**
 * Forward-only migrations, applied in order and recorded in `_migrations`.
 * Section 49: migrations, never destructive resets. Each step is idempotent so
 * a half-applied run can be repeated safely.
 *
 * Note on the unique indexes over nullable columns (phone_e164,
 * provider_call_id, dedupe_key): Postgres treats NULLs as distinct, which is
 * exactly what we want -- many candidates may have no phone, but two candidates
 * in one task may not share the same number.
 */

export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '0001_initial',
    sql: `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL,
  password_hash text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  policy jsonb NOT NULL,
  default_latitude double precision,
  default_longitude double precision,
  default_location_label text,
  preferred_language text NOT NULL DEFAULT 'en',
  calling_language text NOT NULL DEFAULT 'en',
  transcript_retention_days integer NOT NULL DEFAULT 90,
  notifications_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS push_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text NOT NULL,
  platform text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS push_tokens_token_key ON push_tokens (token);

CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instruction text NOT NULL,
  state text NOT NULL DEFAULT 'created',
  interpreted jsonb,
  call_family text,
  latitude double precision,
  longitude double precision,
  location_label text,
  result jsonb,
  headline text,
  clarification_question text,
  failure_code text,
  failure_message text,
  discovered_count integer NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS tasks_user_created_idx ON tasks (user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_user_idempotency_key ON tasks (user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS tasks_state_idx ON tasks (state);

CREATE TABLE IF NOT EXISTS task_events (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  state text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events (task_id, created_at);

CREATE TABLE IF NOT EXISTS business_candidates (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text,
  address text,
  latitude double precision,
  longitude double precision,
  phone_e164 text,
  phone_raw text,
  website text,
  source text NOT NULL,
  source_url text,
  rating double precision,
  review_count integer,
  distance_meters integer,
  opening_hours jsonb,
  phone_verified boolean NOT NULL DEFAULT false,
  score double precision NOT NULL DEFAULT 0,
  rank_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  excluded_reason text,
  selected_for_call boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS business_candidates_task_idx ON business_candidates (task_id);
CREATE UNIQUE INDEX IF NOT EXISTS business_candidates_task_phone_key
  ON business_candidates (task_id, phone_e164);

CREATE TABLE IF NOT EXISTS candidate_sources (
  id text PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES business_candidates(id) ON DELETE CASCADE,
  source text NOT NULL,
  source_id text,
  source_url text,
  contributed jsonb NOT NULL DEFAULT '[]'::jsonb,
  retrieved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS candidate_sources_candidate_idx ON candidate_sources (candidate_id);

CREATE TABLE IF NOT EXISTS calls (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  candidate_id text NOT NULL REFERENCES business_candidates(id) ON DELETE CASCADE,
  business_name text NOT NULL,
  phone_e164 text NOT NULL,
  idempotency_key text NOT NULL,
  provider_call_id text,
  provider_status text,
  disposition text NOT NULL DEFAULT 'pending',
  structured_result jsonb,
  summary text,
  completion_confidence jsonb,
  task_completed boolean,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_code text,
  failure_message text,
  wave integer NOT NULL DEFAULT 1,
  attempt_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS calls_task_idx ON calls (task_id);
CREATE UNIQUE INDEX IF NOT EXISTS calls_provider_call_id_key ON calls (provider_call_id);
CREATE UNIQUE INDEX IF NOT EXISTS calls_idempotency_key ON calls (idempotency_key);

CREATE TABLE IF NOT EXISTS call_attempts (
  id text PRIMARY KEY,
  call_id text NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  provider_attempt_id text,
  status text NOT NULL,
  phone_masked text,
  summary text,
  transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_code text,
  failure_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS call_attempts_call_idx ON call_attempts (call_id);
CREATE UNIQUE INDEX IF NOT EXISTS call_attempts_provider_key
  ON call_attempts (call_id, provider_attempt_id);

CREATE TABLE IF NOT EXISTS authorization_requests (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  prompt text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS authorization_requests_task_idx
  ON authorization_requests (task_id, state);

CREATE TABLE IF NOT EXISTS processed_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  provider_call_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY,
  user_id text,
  task_id text,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_user_idx ON audit_events (user_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id text REFERENCES tasks(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  read_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at);

CREATE TABLE IF NOT EXISTS usage_counters (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day text NOT NULL,
  calls_placed integer NOT NULL DEFAULT 0,
  tasks_created integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  last_error text,
  dedupe_key text,
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_poll_idx ON jobs (state, run_at);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe_key ON jobs (dedupe_key);
`,
  },
  {
    id: '0002_call_provider',
    sql: `
-- Which backend actually placed this call. A call simulated by the fake
-- provider must stay identifiable as simulated for the life of the record,
-- regardless of how the server is configured later.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS provider text;

-- Backfill rows created before this column existed. The fake provider mints
-- ids prefixed 'fake_', so simulated calls are identifiable exactly rather
-- than by guessing at how the server happened to be configured at the time.
-- LEFT() rather than LIKE: no escaping needed in either SQL or JavaScript.
UPDATE calls SET provider = 'fake'
  WHERE provider IS NULL AND LEFT(provider_call_id, 5) = 'fake_';

UPDATE calls SET provider = 'calle'
  WHERE provider IS NULL AND LEFT(provider_call_id, 5) = 'call_';
`,
  },
  {
    id: '0003_intake_and_call_timing',
    sql: `
-- Intake questions Dial asks before starting, and what the user answered.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS clarifying_questions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS clarifying_answers jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Whether the intake step has already run, so answering does not re-ask.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS intake_done boolean NOT NULL DEFAULT false;

-- Ask a few questions before starting. Stored per user.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS ask_clarifying_questions boolean NOT NULL DEFAULT true;

-- When Dial started waiting on the current attempt, so a ring that never
-- resolves can be abandoned rather than polled indefinitely.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS waiting_since timestamptz;

-- A candidate that replaced one which did not answer, for the evidence trail.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS replaced_call_id text;
`,
  },
];
