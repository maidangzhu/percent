import { createHash } from "node:crypto";
import { prisma } from "../db/client.js";
import { elapsedMs, logError, logInfo, logWarn } from "./appLogger.js";
import { callChat } from "./chatClient.js";

interface TaskCandidate {
  should_create: boolean;
  title?: string;
  description?: string;
  due_at?: string | null;
  evidence?: string;
}

interface DetectTasksOptions {
  traceId: string;
  logId: bigint;
  personId: bigint;
  personName: string;
  turnId: bigint;
  occurredAt: Date;
  contextMessages: { role: string; content: string }[];
  newMessages: { role: string; content: string }[];
}

function normalizeText(text: string) {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeDueAt(dueAt: string | null | undefined) {
  if (!dueAt) return "";
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return normalizeText(dueAt);
  return date.toISOString().slice(0, 16);
}

export function buildTaskFingerprint(personName: string, title: string, dueAt: string | null | undefined) {
  const raw = [normalizeText(personName), normalizeText(title), normalizeDueAt(dueAt)].join("|");
  return createHash("sha256").update(raw).digest("hex");
}

function formatMessages(messages: { role: string; content: string }[], personName: string) {
  return messages
    .map((message) => `${message.role === "self" ? "我" : personName}：${message.content}`)
    .join("\n");
}

export async function detectTaskCandidate({
  traceId,
  logId,
  personId,
  personName,
  turnId,
  occurredAt,
  contextMessages,
  newMessages,
}: DetectTasksOptions) {
  const startedAt = Date.now();
  if (!newMessages.length) return null;

  const tools = [
    {
      name: "task_detection",
      description: "判断聊天新增内容是否形成了用户需要记录的待办事项",
      parameters: {
        type: "object",
        properties: {
          should_create: {
            type: "boolean",
            description:
              "当新增消息让待办、提醒、预约、上门服务、见面、跟进事项明确成立时为 true。例如对方提出时间并且我确认、对方确认明天/某时间会来、我需要等待对方上门或跟进、或我主动承诺要做某事。",
          },
          title: { type: "string", description: "待办标题，20字以内" },
          description: { type: "string", description: "补充说明，可为空" },
          due_at: {
            type: ["string", "null"],
            description: "如果能从上下文推断时间，返回 ISO 时间；否则 null。",
          },
          evidence: { type: "string", description: "触发待办的原始聊天片段" },
        },
        required: ["should_create", "title", "description", "due_at", "evidence"],
      },
    },
  ];

  const contextText = formatMessages(contextMessages.slice(-20), personName);
  const newText = formatMessages(newMessages, personName);

  logInfo("task.detect.start", {
    trace_id: traceId,
    log_id: logId,
    person_id: personId,
    turn_id: turnId,
    new_message_count: newMessages.length,
  });

  let candidate: TaskCandidate;
  try {
    const data = await callChat({
      traceId,
      model: "kimi-k2.6",
      messages: [
        {
          role: "system",
          content:
            "你是待办识别助手。你只基于新增聊天判断是否要创建待办/提醒。不要因为历史上下文里重复出现的旧内容重复创建。只要新增消息让一个未来事项明确成立，就应该创建，即使执行者不是用户本人，而是对方要上门、对方要联系用户、双方要约时间、用户需要等待/跟进/记住某件事。若历史上下文里已经提出事项，而本次新增消息是「好的」「可以」「明天」「那就这样」等确认，也应结合上下文创建提醒。不要创建已经过去、没有未来动作、纯闲聊、情绪表达或无法确定事项的任务。",
        },
        {
          role: "user",
          content: `当前时间：${occurredAt.toISOString()}\n聊天对象：${personName}\n\n最近上下文：\n${contextText}\n\n本次新增消息：\n${newText}\n\n请判断本次新增消息是否让一个待办/提醒成立。典型应创建：维修师傅说明明天过来、对方约定某个时间来、我回复好的确认预约、双方约见面/电话/处理事情。title 要写成用户视角的提醒，例如「明天等维修师傅上门」。`,
        },
      ],
      tools,
      toolChoice: { type: "tool", toolName: "task_detection" },
    });

    candidate = (data.tool_calls[0]?.input ?? { should_create: false }) as TaskCandidate;
  } catch (error) {
    logError("task.detect.error", {
      trace_id: traceId,
      log_id: logId,
      person_id: personId,
      turn_id: turnId,
      error,
      duration_ms: elapsedMs(startedAt),
    });
    return null;
  }

  if (!candidate.should_create || !candidate.title?.trim()) {
    logInfo("task.detect.none", {
      trace_id: traceId,
      log_id: logId,
      person_id: personId,
      turn_id: turnId,
      duration_ms: elapsedMs(startedAt),
    });
    return null;
  }

  const dueAt = candidate.due_at ? new Date(candidate.due_at) : null;
  const safeDueAt = dueAt && !Number.isNaN(dueAt.getTime()) ? dueAt : null;
  const fingerprint = buildTaskFingerprint(personName, candidate.title, candidate.due_at);
  const existingTask = await prisma.task.findUnique({ where: { fingerprint } });

  if (existingTask) {
    logWarn("task.detect.duplicate_candidate", {
      trace_id: traceId,
      person_id: personId,
      turn_id: turnId,
      task_id: existingTask.id,
      fingerprint,
    });
    return null;
  }

  logInfo("task.detect.candidate", {
    trace_id: traceId,
    person_id: personId,
    turn_id: turnId,
    title: candidate.title,
    duration_ms: elapsedMs(startedAt),
  });

  return {
    person_id: personId.toString(),
    person_name: personName,
    log_id: logId.toString(),
    source_turn_id: turnId.toString(),
    title: candidate.title.trim(),
    description: candidate.description?.trim() ?? "",
    due_at: safeDueAt,
    evidence: candidate.evidence?.trim() ?? newText.slice(0, 500),
    fingerprint,
    raw_ai_response: candidate,
  };
}
