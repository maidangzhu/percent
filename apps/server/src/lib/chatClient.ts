export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string; mediaType?: string };

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
};

export type ChatToolDefinition = {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

export interface ChatToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ChatResponseData {
  trace_id: string;
  text: string;
  finish_reason: string;
  usage?: unknown;
  tool_calls: ChatToolCall[];
}

interface CallChatOptions {
  traceId: string;
  model?: string;
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  toolChoice?: "auto" | "none" | "required" | { type: "tool"; toolName: string };
  temperature?: number;
  maxOutputTokens?: number;
}

function getServerBaseUrl() {
  const port = Number(process.env.PORT ?? 3000);
  return process.env.INTERNAL_API_BASE_URL ?? `http://localhost:${port}`;
}

export async function callChat({
  traceId,
  model,
  messages,
  tools,
  toolChoice,
  temperature,
  maxOutputTokens,
}: CallChatOptions): Promise<ChatResponseData> {
  const resp = await fetch(`${getServerBaseUrl()}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      trace_id: traceId,
      model,
      messages,
      tools,
      tool_choice: toolChoice,
      temperature,
      max_output_tokens: maxOutputTokens,
    }),
  });

  const json = (await resp.json()) as {
    code?: number;
    message?: string;
    data?: ChatResponseData;
    error?: string;
  };
  if (!resp.ok || !json.data) {
    throw new Error(json.message ?? json.error ?? `chat request failed with status ${resp.status}`);
  }

  return json.data;
}
