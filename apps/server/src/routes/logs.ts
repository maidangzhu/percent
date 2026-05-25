import { Hono } from "hono";
import { prisma } from "../db/client.js";

export const logsRouter = new Hono();

// GET /logs — 分页获取日志列表
logsRouter.get("/", async (c) => {
  const limit = Number(c.req.query("limit") ?? 50);
  const offset = Number(c.req.query("offset") ?? 0);

  const [rows, total] = await Promise.all([
    prisma.log.findMany({
      take: limit,
      skip: offset,
      orderBy: { id: "desc" },
      include: {
        chatTurns: {
          take: 1,
          orderBy: { id: "desc" },
          include: { person: true },
        },
      },
    }),
    prisma.log.count(),
  ]);

  const data = rows.map((log) => {
    const turn = log.chatTurns[0];
    return {
      id: log.id.toString(),
      occurred_at: log.occurredAt,
      app_name: log.appName,
      app_bundle_id: log.appBundleId,
      is_send: log.isSend,
      is_wechat: log.isWechat,
      screenshot_path: log.screenshotPath,
      turn_id: turn?.id.toString() ?? null,
      topic: turn?.topic ?? null,
      partner_name: turn?.person.name ?? null,
      person_id: turn?.person.id.toString() ?? null,
    };
  });

  return c.json({ data, total, limit, offset });
});

// POST /logs — 客户端上报一次 Enter 事件
logsRouter.post("/", async (c) => {
  const body = await c.req.json<{
    occurred_at: string;
    app_name: string;
    app_bundle_id: string;
    is_send: boolean;
    is_wechat: boolean;
    screenshot_path?: string;
  }>();

  const log = await prisma.log.create({
    data: {
      occurredAt: new Date(body.occurred_at),
      appName: body.app_name,
      appBundleId: body.app_bundle_id,
      isSend: body.is_send,
      isWechat: body.is_wechat,
      screenshotPath: body.screenshot_path ?? null,
    },
  });

  return c.json(
    {
      data: {
        id: log.id.toString(),
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
