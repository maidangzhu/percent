import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, type ModelMessage, tool, type ToolSet } from "ai";
import { Hono } from "hono";
import { elapsedMs, logError, logInfo, logWarn } from "../lib/appLogger.js";
import type { ChatContentPart, ChatMessage, ChatToolDefinition } from "../lib/chatClient.js";

export const chatRouter = new Hono();

const DEFAULT_MODEL = "kimi-k2.6";
const MOONSHOT_BASE_URL = process.env.LLM_BASE_URL ?? "https://api.moonshot.cn/v1";

type ChatToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "tool";
      toolName: string;
    };

interface ChatRequestBody {
  trace_id?: string;
  model?: string;
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  temperature?: number;
  max_output_tokens?: number;
}

function normalizeMessages(messages: ChatMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role === "system") {
      return { role: "system", content: String(message.content) };
    }

    if (message.role === "assistant") {
      return { role: "assistant", content: String(message.content) };
    }

    if (typeof message.content === "string") {
      return { role: "user", content: message.content };
    }

    return {
      role: "user",
      content: message.content.map((part) => {
        if (part.type === "text") {
          return { type: "text", text: part.text };
        }

        return {
          type: "image",
          image: part.image,
          mediaType: part.mediaType,
        };
      }),
    };
  });
}

function buildTools(toolDefinitions: ChatToolDefinition[] | undefined) {
  if (!toolDefinitions?.length) return undefined;

  return Object.fromEntries(
    toolDefinitions.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(definition.parameters),
      }),
    ])
  ) as ToolSet;
}

function normalizeToolChoice(
  toolChoice: ChatToolChoice | undefined
): "auto" | "none" | "required" | { type: "tool"; toolName: string } | undefined {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  return toolChoice;
}

chatRouter.post("/", async (c) => {
  const startedAt = Date.now();
  const body = await c.req.json<ChatRequestBody>();
  const traceId =
    body.trace_id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    logWarn("chat.request.invalid", { trace_id: traceId, reason: "messages_required" });
    return c.json({ error: "messages are required" }, 400);
  }

  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    logError("chat.ai.missing_api_key", { trace_id: traceId });
    return c.json({ error: "LLM_API_KEY not set" }, 500);
  }

  const modelId = body.model ?? DEFAULT_MODEL;
  const moonshot = createOpenAICompatible({
    name: "moonshot",
    baseURL: MOONSHOT_BASE_URL,
    apiKey,
    transformRequestBody: (args) => ({
      ...args,
      thinking: { type: "disabled" },
    }),
  });

  const tools = buildTools(body.tools);
  const toolChoice = normalizeToolChoice(body.tool_choice);

  logInfo("chat.request.start", {
    trace_id: traceId,
    model: modelId,
    message_count: body.messages.length,
    tool_count: body.tools?.length ?? 0,
    tool_choice: body.tool_choice,
  });

  try {
    const result = await generateText({
      model: moonshot.chatModel(modelId),
      messages: normalizeMessages(body.messages),
      tools,
      toolChoice,
      temperature: body.temperature,
      maxOutputTokens: body.max_output_tokens,
      experimental_include: {
        requestBody: false,
        responseBody: false,
      },
    });

    logInfo("chat.request.success", {
      trace_id: traceId,
      model: modelId,
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
          id: toolCall.toolCallId,
          name: toolCall.toolName,
          input: toolCall.input,
        })),
      },
    });
  } catch (error) {
    logError("chat.request.error", {
      trace_id: traceId,
      model: modelId,
      error,
      duration_ms: elapsedMs(startedAt),
    });

    return c.json({ error: "AI request failed", trace_id: traceId }, 502);
  }
});
