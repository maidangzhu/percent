import { Hono } from "hono";
import { prisma } from "../db/client.js";

export const peopleRouter = new Hono();

// GET /people — 所有联系人 + 汇总信息
peopleRouter.get("/", async (c) => {
  const people = await prisma.person.findMany({
    include: {
      _count: { select: { chatTurns: true } },
      chatTurns: {
        take: 1,
        orderBy: { capturedAt: "desc" },
        select: { capturedAt: true },
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  const data = people.map((p) => ({
    id: p.id.toString(),
    name: p.name,
    client_app: p.clientApp,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    turn_count: p._count.chatTurns,
    last_chat_at: p.chatTurns[0]?.capturedAt ?? null,
  }));

  return c.json({ data });
});

// GET /people/:id — 某人的详细聊天记录
peopleRouter.get("/:id", async (c) => {
  const personId = BigInt(c.req.param("id"));

  const person = await prisma.person.findUnique({
    where: { id: personId },
    include: {
      chatTurns: {
        orderBy: { capturedAt: "desc" },
        include: {
          messages: { orderBy: { seq: "asc" } },
        },
      },
    },
  });

  if (!person) return c.json({ error: "not found" }, 404);

  return c.json({
    data: {
      id: person.id.toString(),
      name: person.name,
      client_app: person.clientApp,
      created_at: person.createdAt,
      updated_at: person.updatedAt,
      turns: person.chatTurns.map((t) => ({
        id: t.id.toString(),
        log_id: t.logId.toString(),
        topic: t.topic,
        captured_at: t.capturedAt,
        messages: t.messages.map((m) => ({ role: m.role, content: m.content })),
      })),
    },
  });
});
