import { Hono } from "hono";
import type { MessageListInput } from "@mastra/core/agent/message-list";
import { elapsedMs, logError, logInfo, logWarn } from "../lib/appLogger.js";
import { screenAgent } from "../agents/screenAgent.js";

export const agentRouter = new Hono();

type AgentChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type AgentChatRequestBody = {
  trace_id?: string;
  messages: AgentChatMessage[];
  screen_context: {
    app_name: string;
    occurred_at: string;
    image_base64: string;
  };
  max_output_tokens?: number;
};

agentRouter.post("/chat", async (c) => {
  const startedAt = Date.now();
  const body = await c.req.json<AgentChatRequestBody>();
  const traceId =
    body.trace_id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  if (!process.env.LLM_API_KEY) {
    logError("agent.chat.missing_api_key", { trace_id: traceId });
    return c.json({ error: "LLM_API_KEY not set" }, 500);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    logWarn("agent.chat.invalid", { trace_id: traceId, reason: "messages_required" });
    return c.json({ error: "messages are required" }, 400);
  }

  if (!body.screen_context?.image_base64) {
    logWarn("agent.chat.invalid", { trace_id: traceId, reason: "screen_context_required" });
    return c.json({ error: "screen_context.image_base64 is required" }, 400);
  }

  const lastUserIndex = body.messages.map((message) => message.role).lastIndexOf("user");
  const latestUserMessage = lastUserIndex >= 0 ? body.messages[lastUserIndex] : null;
  if (!latestUserMessage?.content.trim()) {
    logWarn("agent.chat.invalid", { trace_id: traceId, reason: "user_message_required" });
    return c.json({ error: "latest user message is required" }, 400);
  }

  const history = body.messages
    .slice(Math.max(0, body.messages.length - 8), lastUserIndex)
    .filter((message) => message.content.trim())
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));

  const messages = [
    ...history,
    {
      role: "user",
      content: [
        { type: "image", image: body.screen_context.image_base64, mediaType: "image/png" },
        {
          type: "text",
          text: `当前前台应用：${body.screen_context.app_name}\n时间：${body.screen_context.occurred_at}\n用户问题：${latestUserMessage.content.trim()}`,
        },
      ],
    },
  ] as MessageListInput;

  logInfo("agent.chat.start", {
    trace_id: traceId,
    message_count: body.messages.length,
    history_count: history.length,
    app_name: body.screen_context.app_name,
  });

  try {
    const result = await screenAgent.generate(messages, {
      maxSteps: 5,
      modelSettings: {
        maxOutputTokens: body.max_output_tokens ?? 600,
      },
    });

    logInfo("agent.chat.success", {
      trace_id: traceId,
      finish_reason: result.finishReason,
      tool_call_count: result.toolCalls.length,
      usage: result.totalUsage,
      duration_ms: elapsedMs(startedAt),
    });

    return c.json({
      data: {
        trace_id: traceId,
        text: result.text,
        finish_reason: result.finishReason,
        usage: result.totalUsage,
        tool_calls: result.toolCalls.map((toolCall) => ({
          id: toolCall.payload.toolCallId,
          name: toolCall.payload.toolName,
          input: toolCall.payload.args,
        })),
        tool_results: result.toolResults,
      },
    });
  } catch (error) {
    logError("agent.chat.error", {
      trace_id: traceId,
      error,
      duration_ms: elapsedMs(startedAt),
    });

    return c.json({ error: "Agent request failed", trace_id: traceId }, 502);
  }
});
