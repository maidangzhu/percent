-- Migration 002: tasks
-- Created: 2026-05-25

CREATE TABLE IF NOT EXISTS tasks (
  id              BIGSERIAL PRIMARY KEY,
  person_id       BIGINT REFERENCES people(id),
  log_id          BIGINT REFERENCES logs(id) ON DELETE SET NULL,
  source_turn_id  BIGINT REFERENCES chat_turns(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  due_at          TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  fingerprint     TEXT NOT NULL UNIQUE,
  evidence        TEXT NOT NULL DEFAULT '',
  raw_ai_response JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_due_at ON tasks(status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_person_id ON tasks(person_id);
CREATE INDEX IF NOT EXISTS idx_tasks_source_turn_id ON tasks(source_turn_id);
