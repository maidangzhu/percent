-- Migration 001: initial schema
-- Created: 2026-05-22

-- 每次按下 Enter 的原始事件日志
CREATE TABLE IF NOT EXISTS logs (
  id          BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL,
  app_name    TEXT        NOT NULL,
  app_bundle_id TEXT      NOT NULL DEFAULT '',
  is_send     BOOLEAN     NOT NULL DEFAULT false,
  is_wechat   BOOLEAN     NOT NULL DEFAULT false,
  screenshot_path TEXT,               -- 截图文件路径（可选）
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 识别出的聊天对象（人物表）
CREATE TABLE IF NOT EXISTS people (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  client_app  TEXT        NOT NULL DEFAULT 'WeChat',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (name, client_app)           -- 同名+同app去重
);

-- 每次 AI 分析的一次聊天快照（一次 Enter = 一个 turn）
CREATE TABLE IF NOT EXISTS chat_turns (
  id          BIGSERIAL PRIMARY KEY,
  log_id      BIGINT      NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  person_id   BIGINT      NOT NULL REFERENCES people(id),
  topic       TEXT        NOT NULL DEFAULT '',
  captured_at TIMESTAMPTZ NOT NULL,
  raw_ai_response JSONB,              -- 原始 AI 返回，保留备查
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- turn 内的单条消息
CREATE TABLE IF NOT EXISTS chat_messages (
  id          BIGSERIAL PRIMARY KEY,
  turn_id     BIGINT      NOT NULL REFERENCES chat_turns(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL CHECK (role IN ('self', 'other')),
  content     TEXT        NOT NULL,
  seq         INT         NOT NULL DEFAULT 0,  -- 消息顺序
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_logs_occurred_at    ON logs(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_app_bundle_id  ON logs(app_bundle_id);
CREATE INDEX IF NOT EXISTS idx_chat_turns_person_id ON chat_turns(person_id);
CREATE INDEX IF NOT EXISTS idx_chat_turns_log_id    ON chat_turns(log_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_turn_id ON chat_messages(turn_id, seq);
