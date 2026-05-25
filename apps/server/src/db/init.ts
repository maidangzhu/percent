import { LOCAL_DATABASE_PATH } from "../lib/paths.js";
import { newSnowflakeId } from "../lib/snowflake.js";
import { prisma } from "./client.js";

type SqlExecutor = {
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown>;
};

type LegacyLog = {
  id: number;
  occurred_at: Date;
  app_name: string;
  app_bundle_id: string;
  is_send: boolean;
  is_wechat: boolean;
  screenshot_path: string | null;
  created_at: Date;
};

type LegacyPerson = {
  id: number;
  name: string;
  client_app: string;
  created_at: Date;
  updated_at: Date;
};

type LegacyChatTurn = {
  id: number;
  log_id: number;
  person_id: number;
  topic: string;
  captured_at: Date;
  raw_ai_response: unknown;
  created_at: Date;
};

type LegacyChatMessage = {
  id: number;
  turn_id: number;
  role: string;
  content: string;
  seq: number;
  created_at: Date;
};

type LegacyTask = {
  id: number;
  person_id: number | null;
  log_id: number | null;
  source_turn_id: number | null;
  title: string;
  description: string;
  due_at: Date | null;
  status: string;
  fingerprint: string;
  evidence: string;
  raw_ai_response: unknown;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
};

async function tableExists(name: string) {
  const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    name
  );
  return rows.length > 0;
}

async function columnType(table: string, column: string) {
  const rows = await prisma.$queryRawUnsafe<{ name: string; type: string }[]>(
    `PRAGMA table_info(${table})`
  );
  return rows.find((row) => row.name === column)?.type.toUpperCase() ?? null;
}

async function migrateLegacyIntegerIds() {
  if (!(await tableExists("logs"))) return;
  if ((await columnType("logs", "id")) !== "INTEGER") return;

  const logs = await prisma.$queryRawUnsafe<LegacyLog[]>("SELECT * FROM logs ORDER BY id ASC");
  const people = await prisma.$queryRawUnsafe<LegacyPerson[]>("SELECT * FROM people ORDER BY id ASC");
  const turns = await prisma.$queryRawUnsafe<LegacyChatTurn[]>("SELECT * FROM chat_turns ORDER BY id ASC");
  const messages = await prisma.$queryRawUnsafe<LegacyChatMessage[]>("SELECT * FROM chat_messages ORDER BY id ASC");
  const tasks = await prisma.$queryRawUnsafe<LegacyTask[]>("SELECT * FROM tasks ORDER BY id ASC");

  const logIds = new Map(logs.map((row) => [row.id, newSnowflakeId()]));
  const personIds = new Map(people.map((row) => [row.id, newSnowflakeId()]));
  const turnIds = new Map(turns.map((row) => [row.id, newSnowflakeId()]));
  const messageIds = new Map(messages.map((row) => [row.id, newSnowflakeId()]));
  const taskIds = new Map(tasks.map((row) => [row.id, newSnowflakeId()]));

  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = OFF");
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("ALTER TABLE logs RENAME TO logs_legacy_integer_ids");
    await tx.$executeRawUnsafe("ALTER TABLE people RENAME TO people_legacy_integer_ids");
    await tx.$executeRawUnsafe("ALTER TABLE chat_turns RENAME TO chat_turns_legacy_integer_ids");
    await tx.$executeRawUnsafe("ALTER TABLE chat_messages RENAME TO chat_messages_legacy_integer_ids");
    await tx.$executeRawUnsafe("ALTER TABLE tasks RENAME TO tasks_legacy_integer_ids");

    await createTables(tx);

    for (const row of logs) {
      await tx.$executeRawUnsafe(
        "INSERT INTO logs (id, occurred_at, app_name, app_bundle_id, is_send, is_wechat, screenshot_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        logIds.get(row.id),
        row.occurred_at,
        row.app_name,
        row.app_bundle_id,
        row.is_send,
        row.is_wechat,
        row.screenshot_path,
        row.created_at
      );
    }

    for (const row of people) {
      await tx.$executeRawUnsafe(
        "INSERT INTO people (id, name, client_app, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        personIds.get(row.id),
        row.name,
        row.client_app,
        row.created_at,
        row.updated_at
      );
    }

    for (const row of turns) {
      await tx.$executeRawUnsafe(
        "INSERT INTO chat_turns (id, log_id, person_id, topic, captured_at, raw_ai_response, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        turnIds.get(row.id),
        logIds.get(row.log_id),
        personIds.get(row.person_id),
        row.topic,
        row.captured_at,
        row.raw_ai_response == null ? null : JSON.stringify(row.raw_ai_response),
        row.created_at
      );
    }

    for (const row of messages) {
      await tx.$executeRawUnsafe(
        "INSERT INTO chat_messages (id, turn_id, role, content, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        messageIds.get(row.id),
        turnIds.get(row.turn_id),
        row.role,
        row.content,
        row.seq,
        row.created_at
      );
    }

    for (const row of tasks) {
      await tx.$executeRawUnsafe(
        "INSERT INTO tasks (id, person_id, log_id, source_turn_id, title, description, due_at, status, fingerprint, evidence, raw_ai_response, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        taskIds.get(row.id),
        row.person_id == null ? null : personIds.get(row.person_id),
        row.log_id == null ? null : logIds.get(row.log_id),
        row.source_turn_id == null ? null : turnIds.get(row.source_turn_id),
        row.title,
        row.description,
        row.due_at,
        row.status,
        row.fingerprint,
        row.evidence,
        row.raw_ai_response == null ? null : JSON.stringify(row.raw_ai_response),
        row.created_at,
        row.updated_at,
        row.completed_at
      );
    }

    await tx.$executeRawUnsafe("DROP TABLE logs_legacy_integer_ids");
    await tx.$executeRawUnsafe("DROP TABLE people_legacy_integer_ids");
    await tx.$executeRawUnsafe("DROP TABLE chat_turns_legacy_integer_ids");
    await tx.$executeRawUnsafe("DROP TABLE chat_messages_legacy_integer_ids");
    await tx.$executeRawUnsafe("DROP TABLE tasks_legacy_integer_ids");
  });
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON");
}

async function createTables(db: SqlExecutor = prisma) {
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS logs (
      id TEXT PRIMARY KEY,
      occurred_at DATETIME NOT NULL,
      app_name TEXT NOT NULL,
      app_bundle_id TEXT NOT NULL DEFAULT '',
      is_send BOOLEAN NOT NULL DEFAULT false,
      is_wechat BOOLEAN NOT NULL DEFAULT false,
      screenshot_path TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_logs_occurred_at ON logs(occurred_at DESC)");
  await db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_logs_app_bundle_id ON logs(app_bundle_id)");

  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      client_app TEXT NOT NULL DEFAULT 'WeChat',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (name, client_app)
    )
  `);

  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS chat_turns (
      id TEXT PRIMARY KEY,
      log_id TEXT NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
      person_id TEXT NOT NULL REFERENCES people(id),
      topic TEXT NOT NULL DEFAULT '',
      captured_at DATETIME NOT NULL,
      raw_ai_response JSON,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_chat_turns_person_id ON chat_turns(person_id)");
  await db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_chat_turns_log_id ON chat_turns(log_id)");

  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES chat_turns(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('self', 'other')),
      content TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_chat_messages_turn_id ON chat_messages(turn_id, seq)");

  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      person_id TEXT REFERENCES people(id),
      log_id TEXT REFERENCES logs(id) ON DELETE SET NULL,
      source_turn_id TEXT REFERENCES chat_turns(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      due_at DATETIME,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
      fingerprint TEXT NOT NULL UNIQUE,
      evidence TEXT NOT NULL DEFAULT '',
      raw_ai_response JSON,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    )
  `);
  await db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_tasks_status_due_at ON tasks(status, due_at)");
  await db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_tasks_person_id ON tasks(person_id)");
  await db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_tasks_source_turn_id ON tasks(source_turn_id)");
}

export async function initializeLocalDatabase() {
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON");
  await migrateLegacyIntegerIds();
  await createTables();

  return { path: LOCAL_DATABASE_PATH };
}
