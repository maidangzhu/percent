import { Hono } from "hono";
import { prisma } from "../db/client.js";

export const analyzeRouter = new Hono();

const KIMI_API_URL = "https://api.moonshot.cn/v1/chat/completions";

interface Message {
  role: "self" | "other";
  content: string;
}

interface AnalyzeResult {
  is_chat: boolean;
  partner?: string;
  topic?: string;
  messages?: Message[];
}

async function callKimi(
  imageBase64: string,
  occurredAt: string,
  clientApp: string
): Promise<AnalyzeResult | null> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error("LLM_API_KEY not set");

  const dataUrl = `data:image/png;base64,${imageBase64}`;

  const tools = [
    {
      type: "function",
      function: {
        name: "record_chat_session",
        description:
          "分析截图，如果是即时通讯聊天界面则记录聊天信息；否则 is_chat 填 false。无论如何都必须调用此工具。",
        parameters: {
          type: "object",
          properties: {
            is_chat: { type: "boolean" },
            partner: { type: "string", description: "聊天对象名字" },
            topic: { type: "string", description: "对话主题，20字以内" },
            messages: {
              type: "array",
              description: "截图中可见的最近消息，最多5条",
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["self", "other"] },
                  content: { type: "string" },
                },
                required: ["role", "content"],
              },
            },
          },
          required: ["is_chat"],
        },
      },
    },
  ];

  const resp = await fetch(KIMI_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "kimi-k2.6",
      messages: [
        {
          role: "system",
          content:
            "你是截图分析助手。分析截图后必须调用 record_chat_session 工具，is_chat 表示是否是聊天场景。",
        },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUrl } },
            {
              type: "text",
              text: `请分析截图。时间：${occurredAt}，客户端：${clientApp}。必须调用工具返回结果。`,
            },
          ],
        },
      ],
      tools,
      tool_choice: "auto",
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error("[ai] API error:", resp.status, text.slice(0, 300));
    return null;
  }

  const data = (await resp.json()) as any;
  console.log(
    "[ai] response choices:",
    JSON.stringify(data?.choices?.[0]?.message).slice(0, 200)
  );

  const toolCall = data?.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) return null;

  return JSON.parse(toolCall.function.arguments) as AnalyzeResult;
}

// POST /analyze
// Body: { log_id, occurred_at, app_name, image_base64 }
analyzeRouter.post("/", async (c) => {
  const body = await c.req.json<{
    log_id: number;
    occurred_at: string;
    app_name: string;
    image_base64: string;
  }>();

  const { log_id, occurred_at, app_name, image_base64 } = body;

  if (!log_id || !image_base64) {
    return c.json({ error: "log_id and image_base64 are required" }, 400);
  }

  console.log(`[analyze] log #${log_id} from ${app_name}`);

  const result = await callKimi(image_base64, occurred_at, app_name);
  if (!result || !result.is_chat || !result.partner) {
    console.log(`[analyze] log #${log_id} → not a chat scene`);
    return c.json({ data: { is_chat: false } });
  }

  console.log(
    `[analyze] log #${log_id} → chat with "${result.partner}", topic: ${result.topic}`
  );

  const person = await prisma.person.upsert({
    where: { name_clientApp: { name: result.partner, clientApp: app_name } },
    create: { name: result.partner, clientApp: app_name },
    update: { updatedAt: new Date() },
  });

  const turn = await prisma.chatTurn.create({
    data: {
      logId: BigInt(log_id),
      personId: person.id,
      topic: result.topic ?? "",
      capturedAt: new Date(occurred_at),
      rawAiResponse: result as object,
      messages: result.messages?.length
        ? {
            create: result.messages.map((m, i) => ({
              role: m.role,
              content: m.content,
              seq: i,
            })),
          }
        : undefined,
    },
    include: { messages: { orderBy: { seq: "asc" } } },
  });

  return c.json({
    data: {
      is_chat: true,
      person: {
        id: person.id.toString(),
        name: person.name,
        client_app: person.clientApp,
        created_at: person.createdAt,
        updated_at: person.updatedAt,
      },
      turn: {
        id: turn.id.toString(),
        log_id: turn.logId.toString(),
        topic: turn.topic,
        captured_at: turn.capturedAt,
      },
      messages: turn.messages.map((m) => ({ role: m.role, content: m.content })),
    },
  });
});
