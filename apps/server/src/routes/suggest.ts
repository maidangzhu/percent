import { Hono } from "hono";
import { prisma } from "../db/client.js";

export const suggestRouter = new Hono();

const KIMI_API_URL = "https://api.moonshot.cn/v1/chat/completions";

type Style = "chat_master" | "cautious" | "flirty" | "icebreaker";

const STYLE_PROMPTS: Record<Style, string> = {
  chat_master:
    "你是聊天高手。回复要短（15字以内），自然口语化，带一个勾子让对方忍不住接话。不要解释，直接给回复本身。",
  cautious:
    "你是稳重的沟通者。回复要短（15字以内），言简意赅，不卑不亢，点到为止。不要解释，直接给回复本身。",
  flirty:
    "你深谙海王之道：核心在于「稀缺感+主动权在我」。每条回复都要让对方觉得你有点神秘、有点忙、但又对她/他有一丝特别的兴趣。回复极短（15字以内），用反问或欲言又止制造张力，绝不把话说满。不要解释，直接给回复本身。",
  icebreaker:
    "你擅长打破僵局。回复要短（15字以内），扔出一个意想不到的话题转折或反常识问题，让对话重新活起来。不要解释，直接给回复本身。",
};

const STYLE_NAMES: Record<Style, string> = {
  chat_master: "聊天达人",
  cautious: "谨言慎行",
  flirty: "暧昧拉扯",
  icebreaker: "打破尬聊",
};

// POST /suggest
// Body: { person_id: number, style: Style }
suggestRouter.post("/", async (c) => {
  const body = await c.req.json<{ person_id: number; style: Style }>();
  const { person_id, style } = body;

  if (!person_id || !style || !STYLE_PROMPTS[style]) {
    return c.json({ error: "person_id and valid style are required" }, 400);
  }

  const person = await prisma.person.findUnique({
    where: { id: BigInt(person_id) },
  });
  if (!person) return c.json({ error: "person not found" }, 404);

  const turns = await prisma.chatTurn.findMany({
    where: { personId: person.id },
    orderBy: { capturedAt: "desc" },
    take: 3,
    include: { messages: { orderBy: { seq: "asc" } } },
  });

  if (!turns.length) {
    return c.json({ error: "no chat history found for this person" }, 404);
  }

  const historyText = turns
    .slice()
    .reverse()
    .map((t) =>
      t.messages
        .map((m) => `${m.role === "self" ? "我" : person.name}：${m.content}`)
        .join("\n")
    )
    .join("\n---\n");

  const userPrompt = `以下是我和「${person.name}」的聊天记录：\n\n${historyText}\n\n请以「我」的身份，生成 3 条风格各异的回复建议。`;

  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return c.json({ error: "LLM_API_KEY not set" }, 500);

  const tools = [
    {
      type: "function",
      function: {
        name: "reply_suggestions",
        description: "返回 3 条回复建议",
        parameters: {
          type: "object",
          properties: {
            suggestions: {
              type: "array",
              items: { type: "string" },
              minItems: 3,
              maxItems: 3,
              description: "3 条回复建议，每条不超过 20 字，极简短",
            },
          },
          required: ["suggestions"],
        },
      },
    },
  ];

  console.log(
    `[suggest] person=${person.name}, style=${STYLE_NAMES[style]}, turns=${turns.length}`
  );

  const resp = await fetch(KIMI_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "kimi-k2.6",
      messages: [
        { role: "system", content: STYLE_PROMPTS[style] },
        { role: "user", content: userPrompt },
      ],
      tools,
      tool_choice: "auto",
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error("[suggest] AI error:", resp.status, text.slice(0, 200));
    return c.json({ error: "AI request failed" }, 502);
  }

  const data = (await resp.json()) as any;
  const toolCall = data?.choices?.[0]?.message?.tool_calls?.[0];

  let suggestions: string[];

  if (toolCall) {
    const result = JSON.parse(toolCall.function.arguments) as {
      suggestions: string[];
    };
    suggestions = result.suggestions;
  } else {
    const content: string = data?.choices?.[0]?.message?.content ?? "";
    console.log("[suggest] no tool call, parsing content:", content.slice(0, 300));
    const lines = content
      .split("\n")
      .map((l: string) => l.replace(/^[\d①②③\-\*\.\s]+/, "").trim())
      .filter((l: string) => l.length > 4);
    if (lines.length < 1) {
      return c.json({ error: "AI did not return structured suggestions" }, 502);
    }
    suggestions = lines.slice(0, 3);
  }

  console.log(`[suggest] got ${suggestions.length} suggestions`);

  return c.json({
    data: {
      person_name: person.name,
      style,
      style_name: STYLE_NAMES[style],
      suggestions,
    },
  });
});
