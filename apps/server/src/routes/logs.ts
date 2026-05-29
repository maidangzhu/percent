import { Hono } from "hono";
import { prisma } from "../db/client.js";
import { elapsedMs, logError, logInfo } from "../lib/appLogger.js";
import { newSnowflakeId } from "../lib/snowflake.js";

export const logsRouter = new Hono();
const CACHE_CLEAR_PLACEHOLDER_BUNDLE_ID = "percent.internal.cache";

// GET /logs — 分页获取日志列表
logsRouter.get("/", async (c) => {
  const limit = Number(c.req.query("limit") ?? 50);
  const offset = Number(c.req.query("offset") ?? 0);

  const [rows, total] = await Promise.all([
    prisma.log.findMany({
      take: limit,
      skip: offset,
      where: {
        appBundleId: { not: CACHE_CLEAR_PLACEHOLDER_BUNDLE_ID },
      },
      orderBy: { occurredAt: "desc" },
      include: {
        chatTurns: {
          take: 1,
          orderBy: { capturedAt: "desc" },
          include: { person: true },
        },
      },
    }),
    prisma.log.count({
      where: {
        appBundleId: { not: CACHE_CLEAR_PLACEHOLDER_BUNDLE_ID },
      },
    }),
  ]);

  const data = rows.map((log) => {
    const turn = log.chatTurns[0];
    return {
      id: log.id,
      occurred_at: log.occurredAt,
      app_name: log.appName,
      app_bundle_id: log.appBundleId,
      is_send: log.isSend,
      is_wechat: log.isWechat,
      screenshot_path: log.screenshotPath,
      turn_id: turn?.id ?? null,
      topic: turn?.topic ?? null,
      partner_name: turn?.person.name ?? null,
      person_id: turn?.person.id ?? null,
    };
  });

  return c.json({ data, total, limit, offset });
});

// DELETE /logs — 清空本地缓存数据
logsRouter.delete("/", async (c) => {
  const startedAt = Date.now();

  logInfo("logs.clear.start", {});

  try {
    const result = await prisma.$transaction(async (tx) => {
      const [logCount, personCount, turnCount, messageCount, taskCount] = await Promise.all([
        tx.log.count({
          where: {
            appBundleId: { not: CACHE_CLEAR_PLACEHOLDER_BUNDLE_ID },
          },
        }),
        tx.person.count(),
        tx.chatTurn.count(),
        tx.chatMessage.count(),
        tx.task.count(),
      ]);

      const deletedTasks = await tx.task.deleteMany();
      const deletedMessages = await tx.chatMessage.deleteMany();
      const deletedTurns = await tx.chatTurn.deleteMany();
      const deletedPeople = await tx.person.deleteMany();
      const deletedLogs = await tx.log.deleteMany({
        where: {
          appBundleId: { not: CACHE_CLEAR_PLACEHOLDER_BUNDLE_ID },
        },
      });

      return {
        requested_logs: logCount,
        deleted: deletedLogs.count,
        deleted_logs: deletedLogs.count,
        deleted_people: deletedPeople.count,
        deleted_chat_turns: deletedTurns.count,
        deleted_chat_messages: deletedMessages.count,
        deleted_tasks: deletedTasks.count,
        requested_people: personCount,
        requested_chat_turns: turnCount,
        requested_chat_messages: messageCount,
        requested_tasks: taskCount,
      };
    });

    logInfo("logs.clear.success", {
      ...result,
      duration_ms: elapsedMs(startedAt),
    });

    return c.json({ data: result });
  } catch (error) {
    logError("logs.clear.error", {
      error,
      duration_ms: elapsedMs(startedAt),
    });
    throw error;
  }
});

// POST /logs — 客户端上报一次 Enter 事件
logsRouter.post("/", async (c) => {
  const startedAt = Date.now();
  const body = await c.req.json<{
    occurred_at: string;
    app_name: string;
    app_bundle_id: string;
    is_send: boolean;
    is_wechat: boolean;
    screenshot_path?: string;
  }>();

  logInfo("logs.create.start", {
    app_name: body.app_name,
    app_bundle_id: body.app_bundle_id,
    is_send: body.is_send,
    is_wechat: body.is_wechat,
    has_screenshot: Boolean(body.screenshot_path),
    occurred_at: body.occurred_at,
  });

  let log;
  try {
    log = await prisma.log.create({
      data: {
        id: newSnowflakeId(),
        occurredAt: new Date(body.occurred_at),
        appName: body.app_name,
        appBundleId: body.app_bundle_id,
        isSend: body.is_send,
        isWechat: body.is_wechat,
        screenshotPath: body.screenshot_path ?? null,
      },
    });
  } catch (error) {
    logError("logs.create.error", {
      error,
      duration_ms: elapsedMs(startedAt),
    });
    throw error;
  }

  logInfo("logs.create.success", {
    log_id: log.id,
    duration_ms: elapsedMs(startedAt),
  });

  return c.json(
    {
      data: {
        id: log.id,
        occurred_at: log.occurredAt,
        app_name: log.appName,
        app_bundle_id: log.appBundleId,
        is_send: log.isSend,
        is_wechat: log.isWechat,
        screenshot_path: log.screenshotPath,
        created_at: log.createdAt,
      },
    },
    201
  );
});
