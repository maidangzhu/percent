import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { prisma } from "../db/client.js";
import { mergeOverlappingChatTurns } from "../lib/chatMerge.js";
import { newSnowflakeId } from "../lib/snowflake.js";

const DEFAULT_MODEL = "kimi-k2.6";
const MOONSHOT_BASE_URL = process.env.LLM_BASE_URL ?? "https://api.moonshot.cn/v1";

function createMoonshotModel() {
  const moonshot = createOpenAICompatible({
    name: "moonshot",
    baseURL: MOONSHOT_BASE_URL,
    apiKey: process.env.LLM_API_KEY ?? "",
    transformRequestBody: (args) => ({
      ...args,
      thinking: { type: "disabled" },
    }),
  });

  return moonshot.chatModel(DEFAULT_MODEL);
}

const findPeopleTool = createTool({
  id: "find_people",
  description: "Search local chat contacts by name. Use this before reading chat history when the user mentions a person.",
  inputSchema: z.object({
    query: z.string().optional().describe("Contact name or partial name."),
    limit: z.number().int().min(1).max(20).default(10).optional(),
  }),
  execute: async ({ query, limit = 10 }) => {
    const people = await prisma.person.findMany({
      where: query?.trim()
        ? { name: { contains: query.trim() } }
        : undefined,
      take: limit,
      orderBy: { updatedAt: "desc" },
      include: {
        _count: { select: { chatTurns: true } },
        chatTurns: {
          take: 1,
          orderBy: { capturedAt: "desc" },
          select: { capturedAt: true },
        },
      },
    });

    return {
      people: people.map((person) => ({
        id: person.id,
        name: person.name,
        client_app: person.clientApp,
        turn_count: person._count.chatTurns,
        last_chat_at: person.chatTurns[0]?.capturedAt ?? null,
      })),
    };
  },
});

const getChatContextTool = createTool({
  id: "get_chat_context",
  description: "Read recent local chat history for one contact.",
  inputSchema: z.object({
    person_id: z.string().optional().describe("Exact local person id."),
    person_name: z.string().optional().describe("Contact name if person_id is unknown."),
    limit: z.number().int().min(1).max(80).default(30).optional(),
  }),
  execute: async ({ person_id, person_name, limit = 30 }) => {
    const person = person_id
      ? await prisma.person.findUnique({ where: { id: person_id } })
      : person_name?.trim()
        ? await prisma.person.findFirst({
            where: { name: { contains: person_name.trim() } },
            orderBy: { updatedAt: "desc" },
          })
        : null;

    if (!person) {
      return { person: null, messages: [] };
    }

    const turns = await prisma.chatTurn.findMany({
      where: { personId: person.id },
      orderBy: { capturedAt: "desc" },
      take: Math.max(10, Math.ceil(limit / 3)),
      include: { messages: { orderBy: { seq: "asc" } } },
    });
    const mergedTurns = mergeOverlappingChatTurns(turns).slice(-Math.max(1, limit));
    const messages = mergedTurns
      .flatMap((turn) =>
        turn.messages.map((message) => ({
          role: message.role,
          speaker: message.role === "self" ? "我" : person.name,
          content: message.content,
          captured_at: turn.capturedAt,
          topic: turn.topic,
        }))
      )
      .slice(-limit);

    return {
      person: {
        id: person.id,
        name: person.name,
        client_app: person.clientApp,
      },
      messages,
    };
  },
});

const listTasksTool = createTool({
  id: "list_tasks",
  description: "List local tasks that Percent has recorded.",
  inputSchema: z.object({
    status: z.enum(["pending", "completed", "all"]).default("pending").optional(),
    limit: z.number().int().min(1).max(50).default(20).optional(),
  }),
  execute: async ({ status = "pending", limit = 20 }) => {
    const tasks = await prisma.task.findMany({
      where: status === "all" ? undefined : { status },
      take: limit,
      orderBy: [{ status: "desc" }, { dueAt: "asc" }, { createdAt: "desc" }],
      include: { person: true },
    });

    return {
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        due_at: task.dueAt,
        person_name: task.person?.name ?? null,
        evidence: task.evidence,
      })),
    };
  },
});

const createTaskTool = createTool({
  id: "create_task",
  description: "Create a local task only when the user explicitly asks you to remember, add, create, or record a task.",
  inputSchema: z.object({
    title: z.string().min(1).max(80),
    description: z.string().default("").optional(),
    due_at: z.string().nullable().optional().describe("ISO datetime if known, otherwise null."),
  }),
  execute: async ({ title, description = "", due_at }) => {
    const dueAt = due_at ? new Date(due_at) : null;
    const safeDueAt = dueAt && !Number.isNaN(dueAt.getTime()) ? dueAt : null;
    const task = await prisma.task.create({
      data: {
        id: newSnowflakeId(),
        title: title.trim(),
        description: description.trim(),
        dueAt: safeDueAt,
        fingerprint: `agent:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        evidence: "Created from Percent screen agent chat.",
        rawAiResponse: { source: "screen_agent" },
      },
    });

    return {
      task: {
        id: task.id,
        title: task.title,
        description: task.description,
        due_at: task.dueAt,
        status: task.status,
      },
    };
  },
});

export const percentAgent = new Agent({
  id: "percent-agent",
  name: "Percent Agent",
  instructions:
    "你是 Percent 桌面气泡里的个人助理 Agent。回答要简洁、直接、可执行。需要当前屏幕时调用 read_screen 客户端工具；不要臆造工具结果里没有的信息。需要历史上下文时，可以用工具查询本地联系人、聊天记录和任务。只有当用户明确要求记录/新增待办时，才调用 create_task。回复使用用户提问的语言。",
  model: createMoonshotModel(),
  tools: {
    find_people: findPeopleTool,
    get_chat_context: getChatContextTool,
    list_tasks: listTasksTool,
    create_task: createTaskTool,
  },
  defaultOptions: {
    maxSteps: 5,
    modelSettings: {
      temperature: 0.6,
    },
  },
});
