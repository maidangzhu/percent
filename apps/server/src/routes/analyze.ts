import { Hono } from "hono";
import { prisma } from "../db/client.js";
import { elapsedMs, logError, logInfo, logWarn } from "../lib/appLogger.js";
import { callChat } from "../lib/chatClient.js";
import { getNewMessagesFromSnapshot } from "../lib/chatMerge.js";
import { newSnowflakeId } from "../lib/snowflake.js";
import { detectTaskCandidate } from "../lib/taskDetector.js";

export const analyzeRouter = new Hono();

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
  clientApp: string,
  traceId: string,
  logId: string
): Promise<AnalyzeResult | null> {
  const startedAt = Date.now();
  const tools = [
    {
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
  ];

  logInfo("analyze.ai.request.start", {
    trace_id: traceId,
    log_id: logId,
    model: "kimi-k2.6",
    image_base64_chars: imageBase64.length,
    client_app: clientApp,
    occurred_at: occurredAt,
  });

  let data;
  try {
    data = await callChat({
      traceId,
      model: "kimi-k2.6",
      messages: [
        {
          role: "system",
          content:
            "你是截图分析助手。分析截图后必须调用 record_chat_session 工具，is_chat 表示是否是聊天场景。messages 必须严格按截图视觉顺序从上到下返回：数组第 1 条是截图里最上方可见的消息，最后 1 条是最下方最新的消息。不要按时间倒序返回。",
        },
        {
          role: "user",
          content: [
            { type: "image", image: imageBase64, mediaType: "image/png" },
            {
              type: "text",
              text: `请分析截图。时间：${occurredAt}，客户端：${clientApp}。必须调用工具返回结果。若是聊天界面，messages 必须按截图从上到下的显示顺序返回，不要倒序。`,
            },
          ],
        },
      ],
      tools,
      toolChoice: { type: "tool", toolName: "record_chat_session" },
    });
  } catch (error) {
    logError("analyze.ai.request.error", {
      trace_id: traceId,
      log_id: logId,
      error,
      duration_ms: elapsedMs(startedAt),
    });
    throw error;
  }

  const toolCall = data.tool_calls[0];
  logInfo("analyze.ai.response.success", {
    trace_id: traceId,
    log_id: logId,
    has_tool_call: Boolean(toolCall),
    finish_reason: data.finish_reason,
    usage: data?.usage,
    duration_ms: elapsedMs(startedAt),
  });

  if (!toolCall) {
    logWarn("analyze.ai.no_tool_call", {
      trace_id: traceId,
      log_id: logId,
      text_preview: data.text.slice(0, 500),
    });
    return null;
  }

  const result = toolCall.input as AnalyzeResult;
  logInfo("analyze.ai.tool_result", {
    trace_id: traceId,
    log_id: logId,
    is_chat: result.is_chat,
    partner: result.partner,
    topic: result.topic,
    message_count: result.messages?.length ?? 0,
  });

  return result;
}

// POST /analyze
// Body: { log_id, occurred_at, app_name, image_base64 }
analyzeRouter.post("/", async (c) => {
  const startedAt = Date.now();
  const body = await c.req.json<{
    log_id: string;
    occurred_at: string;
    app_name: string;
    image_base64: string;
    detect_task?: boolean;
  }>();

  const { log_id: logId, occurred_at, app_name, image_base64 } = body;
  const shouldDetectTask = body.detect_task ?? true;
  const traceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  if (!logId || !image_base64) {
    logWarn("analyze.request.invalid", {
      trace_id: traceId,
      has_log_id: Boolean(logId),
      has_image_base64: Boolean(image_base64),
    });
    return c.json({ error: "log_id and image_base64 are required" }, 400);
  }

  logInfo("analyze.request.start", {
    trace_id: traceId,
    log_id: logId,
    app_name,
    occurred_at,
    image_base64_chars: image_base64.length,
    detect_task: shouldDetectTask,
  });

  let result: AnalyzeResult | null;
  try {
    result = await callKimi(image_base64, occurred_at, app_name, traceId, logId);
  } catch (error) {
    logError("analyze.request.error", {
      trace_id: traceId,
      log_id: logId,
      error,
      duration_ms: elapsedMs(startedAt),
    });
    return c.json({ error: "AI request failed", trace_id: traceId }, 502);
  }

  if (!result || !result.is_chat || !result.partner) {
    logInfo("analyze.result.not_chat", {
      trace_id: traceId,
      log_id: logId,
      has_result: Boolean(result),
      is_chat: result?.is_chat ?? false,
      has_partner: Boolean(result?.partner),
      duration_ms: elapsedMs(startedAt),
    });
    return c.json({ data: { is_chat: false, trace_id: traceId } });
  }

  logInfo("analyze.result.chat_detected", {
    trace_id: traceId,
    log_id: logId,
    partner: result.partner,
    topic: result.topic,
    message_count: result.messages?.length ?? 0,
  });

  let person;
  let turn;
  let taskCandidate = null;

  try {
    const dbStartedAt = Date.now();
    person = await prisma.person.upsert({
      where: { name_clientApp: { name: result.partner, clientApp: app_name } },
      create: { id: newSnowflakeId(), name: result.partner, clientApp: app_name },
      update: { updatedAt: new Date() },
    });

    logInfo("analyze.db.person.upserted", {
      trace_id: traceId,
      log_id: logId,
      person_id: person.id,
      partner: person.name,
      duration_ms: elapsedMs(dbStartedAt),
    });

    const existingTurns = await prisma.chatTurn.findMany({
      where: { personId: person.id },
      orderBy: { capturedAt: "asc" },
      include: { messages: { orderBy: { seq: "asc" } } },
    });
    const existingMessages = existingTurns.flatMap((existingTurn: { messages: { role: string; content: string }[] }) =>
      existingTurn.messages.map((message: { role: string; content: string }) => ({
        role: message.role,
        content: message.content,
      }))
    );
    const newMessages = getNewMessagesFromSnapshot(
      existingMessages,
      result.messages ?? []
    );

    logInfo("analyze.messages.deduped", {
      trace_id: traceId,
      log_id: logId,
      person_id: person.id,
      snapshot_message_count: result.messages?.length ?? 0,
      new_message_count: newMessages.length,
    });

    if (!newMessages.length) {
      logInfo("analyze.db.turn.skipped_no_new_messages", {
        trace_id: traceId,
        log_id: logId,
        person_id: person.id,
        duration_ms: elapsedMs(startedAt),
      });

      return c.json({
        data: {
          trace_id: traceId,
          is_chat: true,
          skipped_duplicate: true,
          person: {
            id: person.id,
            name: person.name,
            client_app: person.clientApp,
            created_at: person.createdAt,
            updated_at: person.updatedAt,
          },
          messages: [],
        },
      });
    }

    const turnStartedAt = Date.now();
    turn = await prisma.chatTurn.create({
      data: {
        id: newSnowflakeId(),
        logId,
        personId: person.id,
        topic: result.topic ?? "",
        capturedAt: new Date(occurred_at),
        rawAiResponse: { ...result, original_messages: result.messages } as object,
        messages: {
              create: newMessages.map((m, i) => ({
                id: newSnowflakeId(),
                role: m.role,
                content: m.content,
                seq: i,
              })),
            },
      },
      include: { messages: { orderBy: { seq: "asc" } } },
    });

    logInfo("analyze.db.turn.created", {
      trace_id: traceId,
      log_id: logId,
      turn_id: turn.id,
      person_id: person.id,
      message_count: turn.messages.length,
      duration_ms: elapsedMs(turnStartedAt),
    });

    if (shouldDetectTask) {
      taskCandidate = await detectTaskCandidate({
        traceId,
        logId,
        personId: person.id,
        personName: person.name,
        turnId: turn.id,
        occurredAt: new Date(occurred_at),
        contextMessages: [...existingMessages, ...newMessages],
        newMessages,
      });
    } else {
      logInfo("analyze.task.skipped", {
        trace_id: traceId,
        log_id: logId,
        person_id: person.id,
        turn_id: turn.id,
      });
    }
  } catch (error) {
    logError("analyze.db.error", {
      trace_id: traceId,
      log_id: logId,
      error,
      duration_ms: elapsedMs(startedAt),
    });
    throw error;
  }

  logInfo("analyze.request.success", {
    trace_id: traceId,
    log_id: logId,
    person_id: person.id,
    turn_id: turn.id,
    has_task_candidate: Boolean(taskCandidate),
    duration_ms: elapsedMs(startedAt),
  });

  return c.json({
    data: {
      trace_id: traceId,
      is_chat: true,
      person: {
        id: person.id,
        name: person.name,
        client_app: person.clientApp,
        created_at: person.createdAt,
        updated_at: person.updatedAt,
      },
      turn: {
        id: turn.id,
        log_id: turn.logId,
        topic: turn.topic,
        captured_at: turn.capturedAt,
      },
      messages: turn.messages.map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })),
      task_candidate: taskCandidate,
    },
  });
});
