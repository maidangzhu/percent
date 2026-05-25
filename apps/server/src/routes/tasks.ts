import { Hono } from "hono";
import { prisma } from "../db/client.js";
import { newSnowflakeId } from "../lib/snowflake.js";
import { buildTaskFingerprint } from "../lib/taskDetector.js";

export const tasksRouter = new Hono();

function serializeTask(task: any) {
  return {
    id: task.id,
    person_id: task.personId ?? null,
    person_name: task.person?.name ?? null,
    log_id: task.logId ?? null,
    source_turn_id: task.sourceTurnId ?? null,
    title: task.title,
    description: task.description,
    due_at: task.dueAt,
    status: task.status,
    evidence: task.evidence,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    completed_at: task.completedAt,
  };
}

tasksRouter.get("/", async (c) => {
  const status = c.req.query("status");
  const tasks = await prisma.task.findMany({
    where: status && status !== "all" ? { status } : undefined,
    orderBy: [{ status: "desc" }, { dueAt: "asc" }, { createdAt: "desc" }],
    include: { person: true },
  });

  return c.json({ data: tasks.map(serializeTask) });
});

tasksRouter.post("/", async (c) => {
  const body = await c.req.json<{
    title: string;
    description?: string;
    due_at?: string | null;
  }>();

  if (!body.title?.trim()) {
    return c.json({ error: "title is required" }, 400);
  }

  const task = await prisma.task.create({
    data: {
      id: newSnowflakeId(),
      title: body.title.trim(),
      description: body.description?.trim() ?? "",
      dueAt: body.due_at ? new Date(body.due_at) : null,
      fingerprint: `manual:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    },
    include: { person: true },
  });

  return c.json({ data: serializeTask(task) }, 201);
});

tasksRouter.post("/confirm", async (c) => {
  const body = await c.req.json<{
    person_id?: string | null;
    person_name?: string | null;
    log_id?: string | null;
    source_turn_id?: string | null;
    title: string;
    description?: string;
    due_at?: string | null;
    evidence?: string;
    fingerprint?: string;
    raw_ai_response?: unknown;
  }>();

  if (!body.title?.trim()) {
    return c.json({ error: "title is required" }, 400);
  }

  const fingerprint =
    body.fingerprint ??
    buildTaskFingerprint(body.person_name ?? "", body.title, body.due_at ?? null);

  const existingTask = await prisma.task.findUnique({ where: { fingerprint }, include: { person: true } });
  if (existingTask) {
    return c.json({ data: { task: serializeTask(existingTask), duplicated: true } });
  }

  const task = await prisma.task.create({
    data: {
      id: newSnowflakeId(),
      personId: body.person_id ?? null,
      logId: body.log_id ?? null,
      sourceTurnId: body.source_turn_id ?? null,
      title: body.title.trim(),
      description: body.description?.trim() ?? "",
      dueAt: body.due_at ? new Date(body.due_at) : null,
      evidence: body.evidence?.trim() ?? "",
      fingerprint,
      rawAiResponse: (body.raw_ai_response ?? body) as object,
    },
    include: { person: true },
  });

  return c.json({ data: { task: serializeTask(task), duplicated: false } }, 201);
});

tasksRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    title?: string;
    description?: string;
    due_at?: string | null;
    status?: "pending" | "completed";
  }>();

  const task = await prisma.task.update({
    where: { id },
    data: {
      title: body.title?.trim(),
      description: body.description?.trim(),
      dueAt:
        body.due_at === undefined
          ? undefined
          : body.due_at
            ? new Date(body.due_at)
            : null,
      status: body.status,
      completedAt:
        body.status === "completed"
          ? new Date()
          : body.status === "pending"
            ? null
            : undefined,
    },
    include: { person: true },
  });

  return c.json({ data: serializeTask(task) });
});

tasksRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await prisma.task.delete({ where: { id } });
  return c.json({ data: { ok: true } });
});
