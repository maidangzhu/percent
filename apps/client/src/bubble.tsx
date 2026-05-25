import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";

// ---- 类型定义 ----

interface EnterEvent {
  entry_id: number;
  occurred_at: string;
  app_name: string;
  app_bundle_id: string;
  is_send: boolean;
  is_wechat: boolean;
  screenshot_path: string | null;
}

interface CaptureContext {
  occurred_at: string;
  app_name: string;
  app_bundle_id: string;
  is_send: boolean;
  is_wechat: boolean;
  screenshot_path: string | null;
}

interface BubbleNativeHoverPayload {
  name: string;
  hovering: boolean;
}

type AgentRole = "user" | "assistant";

interface AgentMessage {
  id: string;
  role: AgentRole;
  content: string;
}

interface AgentScreenContext {
  captured: CaptureContext;
  imageBase64: string;
}

// ---- 配置 ----

const API_BASE = "http://localhost:3000";

interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

interface TaskCandidate {
  person_id: string | null;
  person_name: string | null;
  log_id: string | null;
  source_turn_id: string | null;
  title: string;
  description: string;
  due_at: string | null;
  evidence: string;
  fingerprint: string;
  raw_ai_response?: unknown;
}

const MOCK_TASK_CANDIDATE: TaskCandidate = {
  person_id: null,
  person_name: "Mock 测试",
  log_id: null,
  source_turn_id: null,
  title: "Mock 测试 Task",
  description: "预览右下角 AI 确认气泡。",
  due_at: null,
  evidence: "Mock：是否将识别到的任务填充到 Task？",
  fingerprint: "mock-task-preview",
  raw_ai_response: { source: "task-page-preview" },
};

type TaskCandidateHandler = (candidate: TaskCandidate, isMockPreview?: boolean) => void;

interface AnalyzePipelineResult {
  logId: string;
  result: {
    is_chat: boolean;
    person?: { id: number | string; name: string };
    turn?: { id: number | string; topic: string };
    messages?: { role: string; content: string }[];
    trace_id?: string;
    task_candidate?: TaskCandidate | null;
  };
}

interface SuggestionResult {
  suggestion: string;
  suggestions: string[];
  personName: string;
}

interface SuggestionPanel {
  title: string;
  description: string;
  suggestion?: string;
  error?: boolean;
}

// ---- 截图转 base64（通过 Rust command，避免 fs scope 限制）----

async function imagePathToBase64(path: string): Promise<string> {
  return await invoke<string>("read_file_base64", { path });
}

// ---- 核心流程 ----

async function runAnalyzePipeline(
  event: Omit<EnterEvent, "entry_id">,
  onTaskCandidate: TaskCandidateHandler,
  entryId?: number,
  options: { forceAnalyze?: boolean; fallbackAppName?: string; detectTask?: boolean } = {}
): Promise<AnalyzePipelineResult | null> {
  const pipelineStartedAt = performance.now();
  console.log("[bubble] pipeline.start", JSON.stringify(event));

  // 1. POST /logs — 创建日志条目，拿到 log_id
  let logId: string;
  try {
    const startedAt = performance.now();
    console.log("[bubble] logs.create.start");
    const logResp = await fetch(`${API_BASE}/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        occurred_at: event.occurred_at,
        app_name: event.app_name,
        app_bundle_id: event.app_bundle_id,
        is_send: event.is_send,
        is_wechat: event.is_wechat,
        screenshot_path: event.screenshot_path ?? undefined,
      }),
    });
    if (!logResp.ok) {
      console.error("[bubble] POST /logs failed:", logResp.status, await logResp.text());
      return null;
    }
    const logData = await logResp.json() as ApiResponse<{ id: string }>;
    logId = logData.data.id;
    console.log("[bubble] logs.create.success", {
      log_id: logId,
      duration_ms: Math.round(performance.now() - startedAt),
    });
  } catch (e) {
    console.error("[bubble] POST /logs error:", e);
    return null;
  }

  // 2. 只有微信 + 有截图才触发 AI 分析
  if ((!event.is_wechat && !options.forceAnalyze) || !event.screenshot_path) {
    console.log("[bubble] analyze.skip", {
      log_id: logId,
      is_wechat: event.is_wechat,
      has_screenshot: Boolean(event.screenshot_path),
      force_analyze: Boolean(options.forceAnalyze),
    });
    return null;
  }

  // 3. 读取截图 → base64
  let imageBase64: string;
  try {
    const startedAt = performance.now();
    console.log("[bubble] screenshot.read.start", {
      log_id: logId,
      screenshot_path: event.screenshot_path,
    });
    imageBase64 = await imagePathToBase64(event.screenshot_path);
    console.log("[bubble] screenshot.read.success", {
      log_id: logId,
      image_base64_chars: imageBase64.length,
      duration_ms: Math.round(performance.now() - startedAt),
    });
  } catch (e) {
    console.error("[bubble] read screenshot failed:", e);
    return null;
  }

  // 4. POST /analyze — 让后端调 AI 分析
  try {
    const startedAt = performance.now();
    console.log("[bubble] analyze.request.start", {
      log_id: logId,
      image_base64_chars: imageBase64.length,
    });
    const analyzeResp = await fetch(`${API_BASE}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        log_id: logId,
        occurred_at: event.occurred_at,
        app_name: options.fallbackAppName ?? event.app_name,
        image_base64: imageBase64,
        detect_task: options.detectTask ?? true,
      }),
    });
    if (!analyzeResp.ok) {
      console.error("[bubble] POST /analyze failed:", analyzeResp.status, await analyzeResp.text());
      return null;
    }
    const analyzeData = await analyzeResp.json() as ApiResponse<
      {
        is_chat: boolean;
        person?: { id: string; name: string };
        turn?: { id: string; topic: string };
        messages?: { role: string; content: string }[];
        trace_id?: string;
        task_candidate?: TaskCandidate | null;
      }
    >;
    const result = analyzeData.data;
    console.log("[bubble] analyze.request.success", {
      log_id: logId,
      trace_id: result.trace_id,
      is_chat: result.is_chat,
      partner: result.person?.name ?? null,
      turn_id: result.turn?.id ?? null,
      message_count: result.messages?.length ?? 0,
      duration_ms: Math.round(performance.now() - startedAt),
    });

    if (result.task_candidate) {
      onTaskCandidate(result.task_candidate, false);
    }

    // 5. 回传给 Rust（更新内存中的 log store，触发 ai-result-updated 事件刷新 UI）
    if (entryId != null) {
      await invoke("report_ai_result", {
        entryId,
        partner: result.person?.name ?? "",
        topic: result.turn?.topic ?? "",
        isChat: result.is_chat,
      });
    }
    console.log("[bubble] pipeline.success", {
      log_id: logId,
      trace_id: result.trace_id,
      duration_ms: Math.round(performance.now() - pipelineStartedAt),
    });
    return { logId, result };
  } catch (e) {
    console.error("[bubble] POST /analyze error:", e);
    return null;
  }
}

async function processEnterEvent(event: EnterEvent, onTaskCandidate: TaskCandidateHandler) {
  await runAnalyzePipeline(event, onTaskCandidate, event.entry_id);
}

// ---- Bubble UI ----

export default function Bubble() {
  const containerRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const taskPopoverRef = useRef<HTMLDivElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const agentOptionRef = useRef<HTMLDivElement>(null);
  const suggestionPanelRef = useRef<HTMLDivElement>(null);
  const agentPanelRef = useRef<HTMLDivElement>(null);
  const agentMessagesRef = useRef<HTMLDivElement>(null);
  const [taskCandidate, setTaskCandidate] = useState<TaskCandidate | null>(null);
  const [suggestionPanel, setSuggestionPanel] = useState<SuggestionPanel | null>(null);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentInput, setAgentInput] = useState("");
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentScreenContext, setAgentScreenContext] = useState<AgentScreenContext | null>(null);
  const [mockPreview, setMockPreview] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<number | null>(null);
  const suggestionTimerRef = useRef<number | null>(null);
  const actionMenuCloseTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  const agentComposingRef = useRef(false);

  const clearAutoCreateTimer = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const displayTaskCandidate: TaskCandidateHandler = (candidate, isMockPreview = false) => {
    clearAutoCreateTimer();
    setMockPreview(isMockPreview);
    setTaskCandidate(candidate);
  };

  const closeTaskBubble = () => {
    clearAutoCreateTimer();
    setTaskCandidate(null);
    setMockPreview(false);
  };

  const clearSuggestionPanelTimer = () => {
    if (suggestionTimerRef.current != null) {
      window.clearTimeout(suggestionTimerRef.current);
      suggestionTimerRef.current = null;
    }
  };

  const clearActionMenuCloseTimer = () => {
    if (actionMenuCloseTimerRef.current != null) {
      window.clearTimeout(actionMenuCloseTimerRef.current);
      actionMenuCloseTimerRef.current = null;
    }
  };

  const openActionMenu = () => {
    clearActionMenuCloseTimer();
    if (!suggestionLoading && !agentLoading) {
      setActionMenuOpen(true);
    }
  };

  const scheduleCloseActionMenu = () => {
    clearActionMenuCloseTimer();
    actionMenuCloseTimerRef.current = window.setTimeout(() => {
      setActionMenuOpen(false);
      actionMenuCloseTimerRef.current = null;
    }, 180);
  };

  const showSuggestionPanel = (panel: SuggestionPanel) => {
    clearSuggestionPanelTimer();
    setSuggestionPanel(panel);
    suggestionTimerRef.current = window.setTimeout(() => {
      setSuggestionPanel(null);
      suggestionTimerRef.current = null;
    }, 6500);
  };

  const confirmTask = async (candidate: TaskCandidate) => {
    clearAutoCreateTimer();
    setConfirming(true);
    try {
      const resp = await fetch(`${API_BASE}/tasks/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(candidate),
      });
      if (!resp.ok) {
        console.error("[bubble] POST /tasks/confirm failed:", resp.status, await resp.text());
        return;
      }
      await invoke("emit_tasks_updated");
      closeTaskBubble();
    } catch (e) {
      console.error("[bubble] POST /tasks/confirm error:", e);
    } finally {
      setConfirming(false);
    }
  };

  useEffect(() => {
    const unlistenCount = listen<number>("count-updated", () => {
      animatePulse();
    });

    const unlistenEnter = listen<EnterEvent>("enter-pressed", (e) => {
      processEnterEvent(e.payload, displayTaskCandidate).catch((err) =>
        console.error("[bubble] pipeline error:", err)
      );
    });
    const unlistenMockTask = listen<TaskCandidate>("mock-task-candidate", (e) => {
      console.log("[bubble] mock.task_candidate", e.payload);
      displayTaskCandidate(e.payload, false);
      animatePulse();
    });
    const unlistenMockPreview = listen<boolean>("mock-task-preview", (e) => {
      if (e.payload) {
        displayTaskCandidate(MOCK_TASK_CANDIDATE, true);
      } else {
        closeTaskBubble();
      }
      animatePulse();
    });

    return () => {
      clearAutoCreateTimer();
      clearSuggestionPanelTimer();
      clearActionMenuCloseTimer();
      unlistenCount.then((f) => f());
      unlistenEnter.then((f) => f());
      unlistenMockTask.then((f) => f());
      unlistenMockPreview.then((f) => f());
    };
  }, []);

  useEffect(() => {
    let frameId = 0;

    const syncHitRegions = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        const container = containerRef.current;
        if (!container) return;

        const containerRect = container.getBoundingClientRect();
        const elements = [
          { name: "bubble", element: bubbleRef.current },
          { name: "task", element: taskPopoverRef.current },
          { name: "menu", element: actionMenuRef.current },
          { name: "agent-option", element: agentOptionRef.current },
          { name: "suggestion", element: suggestionPanelRef.current },
          { name: "agent", element: agentPanelRef.current },
        ].filter(
          (entry): entry is { name: string; element: HTMLDivElement } => Boolean(entry.element)
        );
        const regions = elements.map(({ name, element }) => {
          const rect = element.getBoundingClientRect();
          return {
            name,
            x: rect.left - containerRect.left,
            y: rect.top - containerRect.top,
            width: rect.width,
            height: rect.height,
          };
        });

        invoke("set_bubble_hit_regions", { regions }).catch((e) =>
          console.error("[bubble] set hit regions failed:", e)
        );
      });
    };

    syncHitRegions();

    const observer = new ResizeObserver(syncHitRegions);
    if (containerRef.current) observer.observe(containerRef.current);
    if (bubbleRef.current) observer.observe(bubbleRef.current);
    if (taskPopoverRef.current) observer.observe(taskPopoverRef.current);
    window.addEventListener("resize", syncHitRegions);

    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
      window.removeEventListener("resize", syncHitRegions);
      invoke("set_bubble_hit_regions", { regions: [] }).catch(() => undefined);
    };
  }, [taskCandidate, actionMenuOpen, suggestionPanel, agentOpen, agentMessages, agentLoading]);

  useEffect(() => {
    const unlistenNativeHover = listen<BubbleNativeHoverPayload>("bubble-native-hover", (event) => {
      if (event.payload.name === "bubble" && event.payload.hovering && !suggestionLoading && !agentLoading) {
        openActionMenu();
      } else if (event.payload.name === "menu" && event.payload.hovering) {
        openActionMenu();
      } else if (event.payload.name === "agent-option" && event.payload.hovering) {
        openActionMenu();
      } else if (event.payload.name === "agent" && event.payload.hovering) {
        clearActionMenuCloseTimer();
      } else if (
        (
          event.payload.name === "bubble" ||
          event.payload.name === "menu" ||
          event.payload.name === "agent-option" ||
          event.payload.name === "agent"
        ) &&
        !event.payload.hovering
      ) {
        scheduleCloseActionMenu();
      }
    });

    return () => {
      unlistenNativeHover.then((f) => f());
    };
  }, [suggestionLoading, agentLoading]);

  useEffect(() => {
    clearAutoCreateTimer();
    if (taskCandidate && !mockPreview) {
      timerRef.current = window.setTimeout(() => {
        confirmTask(taskCandidate);
      }, 6500);
    }
  }, [taskCandidate, mockPreview]);

  useEffect(() => {
    const messageList = agentMessagesRef.current;
    if (!messageList) return;
    messageList.scrollTop = messageList.scrollHeight;
  }, [agentMessages, agentLoading, agentOpen]);

  function animatePulse() {
    const el = document.getElementById("bubble-circle");
    if (!el) return;
    el.classList.remove("pulse");
    void el.offsetWidth;
    el.classList.add("pulse");
    setTimeout(() => el.classList.remove("pulse"), 300);
  }

  const handleClick = async () => {
    if (dragRef.current?.moved) return;
    if (agentOpen && agentInput.trim()) {
      await sendAgentMessage();
      return;
    }
    await invoke("show_main_window");
  };

  const generateReplySuggestion = async () => {
    if (suggestionLoading) return;
    clearActionMenuCloseTimer();
    setActionMenuOpen(false);
    setSuggestionPanel(null);
    setSuggestionLoading(true);
    clearSuggestionPanelTimer();

    try {
      const captured = await invoke<CaptureContext>("capture_current_context");
      if (!captured.screenshot_path) {
        showSuggestionPanel({
          title: "生成失败",
          description: "没有拿到截图，请检查截图权限。",
          error: true,
        });
        return;
      }

      const analyzed = await runAnalyzePipeline(
        {
          occurred_at: captured.occurred_at,
          app_name: captured.app_name,
          app_bundle_id: captured.app_bundle_id,
          is_send: captured.is_send,
          is_wechat: true,
          screenshot_path: captured.screenshot_path,
        },
        displayTaskCandidate,
        undefined,
        { forceAnalyze: true, fallbackAppName: "WeChat", detectTask: false }
      );

      const personId = analyzed?.result.person?.id;
      if (!analyzed?.result.is_chat || !personId) {
        showSuggestionPanel({
          title: "未识别到聊天对象",
          description: "请把聊天窗口放到前台后再试。",
          error: true,
        });
        return;
      }

      const suggestResp = await fetch(`${API_BASE}/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ person_id: personId, style: "cautious" }),
      });
      if (!suggestResp.ok) {
        console.error("[bubble] POST /suggest failed:", suggestResp.status, await suggestResp.text());
        showSuggestionPanel({
          title: "生成失败",
          description: "AI 没有返回可用建议。",
          error: true,
        });
        return;
      }
      const suggestData = await suggestResp.json() as ApiResponse<{
        person_name: string;
        suggestions: string[];
      }>;
      const suggestions = suggestData.data.suggestions ?? [];
      const suggestion = suggestions[0]?.trim();
      if (!suggestion) {
        showSuggestionPanel({
          title: "生成失败",
          description: "AI 没有返回可用建议。",
          error: true,
        });
        return;
      }

      const result: SuggestionResult = {
        suggestion,
        suggestions,
        personName: suggestData.data.person_name,
      };
      await writeText(result.suggestion);
      showSuggestionPanel({
        title: "回复建议已复制",
        description: `已基于你和 ${result.personName} 的聊天生成建议。`,
        suggestion: result.suggestion,
      });
    } catch (e) {
      console.error("[bubble] generate reply suggestion failed:", e);
      showSuggestionPanel({
        title: "生成失败",
        description: "生成流程出错，请看控制台日志。",
        error: true,
      });
    } finally {
      setSuggestionLoading(false);
    }
  };

  const captureAgentScreenContext = async () => {
    const captured = await invoke<CaptureContext>("capture_current_context");
    if (!captured.screenshot_path) {
      throw new Error("missing screenshot");
    }

    return {
      captured,
      imageBase64: await imagePathToBase64(captured.screenshot_path),
    };
  };

  const openAgentPanel = async () => {
    clearActionMenuCloseTimer();
    setActionMenuOpen(false);
    setSuggestionPanel(null);
    setAgentLoading(true);

    try {
      setAgentScreenContext(await captureAgentScreenContext());
    } catch (e) {
      console.error("[bubble] capture agent screen context failed:", e);
      setAgentMessages((messages) => [
        ...messages,
        {
          id: `${Date.now()}-assistant-error`,
          role: "assistant",
          content: "没有拿到截图，请检查截图权限。",
        },
      ]);
    } finally {
      setAgentLoading(false);
    }

    setAgentOpen(true);
  };

  const sendAgentMessage = async () => {
    const text = agentInput.trim();
    if (!text || agentLoading) return;

    const userMessage: AgentMessage = {
      id: `${Date.now()}-user`,
      role: "user",
      content: text,
    };
    const nextMessages = [...agentMessages, userMessage];
    setAgentMessages(nextMessages);
    setAgentInput("");
    setAgentLoading(true);

    try {
      if (!agentScreenContext) {
        setAgentMessages((messages) => [
          ...messages,
          {
            id: `${Date.now()}-assistant-error`,
            role: "assistant",
            content: "没有可用的屏幕上下文，请点击 + 重新开始。",
          },
        ]);
        return;
      }

      const history = nextMessages.slice(-8).map((message) => ({
        role: message.role,
        content: message.content,
      }));

      const resp = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "kimi-k2.6",
          max_output_tokens: 600,
          messages: [
            {
              role: "system",
              content:
                "你是一个运行在桌面气泡里的屏幕上下文 Agent。回答要简洁、直接、可执行。你会同时看到用户问题和当前屏幕截图；不要臆造截图里没有的信息。",
            },
            ...history.slice(0, -1),
            {
              role: "user",
              content: [
                { type: "image", image: agentScreenContext.imageBase64, mediaType: "image/png" },
                {
                  type: "text",
                  text: `当前前台应用：${agentScreenContext.captured.app_name}\n时间：${agentScreenContext.captured.occurred_at}\n用户问题：${text}`,
                },
              ],
            },
          ],
        }),
      });

      if (!resp.ok) {
        console.error("[bubble] POST /chat agent failed:", resp.status, await resp.text());
        setAgentMessages((messages) => [
          ...messages,
          {
            id: `${Date.now()}-assistant-error`,
            role: "assistant",
            content: "Agent 请求失败，请看控制台日志。",
          },
        ]);
        return;
      }

      const data = await resp.json() as ApiResponse<{ text: string }>;
      setAgentMessages((messages) => [
        ...messages,
        {
          id: `${Date.now()}-assistant`,
          role: "assistant",
          content: data.data.text.trim() || "没有生成有效回复。",
        },
      ]);
    } catch (e) {
      console.error("[bubble] agent loop failed:", e);
      setAgentMessages((messages) => [
        ...messages,
        {
          id: `${Date.now()}-assistant-error`,
          role: "assistant",
          content: "Agent 处理失败，请看控制台日志。",
        },
      ]);
    } finally {
      setAgentLoading(false);
    }
  };

  const handleDragStart = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleDragMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;

    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.moved = true;

    invoke("move_bubble_by_drag", { deltaX, deltaY }).catch((e) =>
      console.error("[bubble] move by drag failed:", e)
    );
  };

  const handleDragEnd = (event: React.PointerEvent) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      window.setTimeout(() => {
        dragRef.current = null;
      }, 0);
    }
  };

  return (
    <div className="bubble-container" ref={containerRef}>
      {actionMenuOpen && !suggestionLoading && (
        <>
          <div
            className="bubble-chat-option"
            ref={agentOptionRef}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseEnter={openActionMenu}
            onMouseLeave={scheduleCloseActionMenu}
          >
            <button onClick={openAgentPanel}>聊天</button>
          </div>
          <div
            className="bubble-action-menu"
            ref={actionMenuRef}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseEnter={openActionMenu}
            onMouseLeave={scheduleCloseActionMenu}
          >
            <button onClick={generateReplySuggestion}>生成回复建议</button>
          </div>
        </>
      )}
      {agentOpen && (
        <div
          className="agent-panel"
          ref={agentPanelRef}
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
          onMouseEnter={() => {
            clearActionMenuCloseTimer();
            setActionMenuOpen(false);
          }}
          onMouseLeave={scheduleCloseActionMenu}
        >
          <div className="agent-window-actions">
            <button
              className="agent-icon-btn"
              aria-label="New chat"
              title="New chat"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => {
                setAgentMessages([]);
                setAgentInput("");
                setAgentLoading(true);
                captureAgentScreenContext()
                  .then(setAgentScreenContext)
                  .catch((e) => {
                    console.error("[bubble] refresh agent screen context failed:", e);
                    setAgentScreenContext(null);
                    setAgentMessages([
                      {
                        id: `${Date.now()}-assistant-error`,
                        role: "assistant",
                        content: "没有拿到截图，请检查截图权限。",
                      },
                    ]);
                  })
                  .finally(() => setAgentLoading(false));
              }}
            >
              +
            </button>
            <button
              className="agent-icon-btn"
              aria-label="Close chat"
              title="Close chat"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => setAgentOpen(false)}
            >
              ×
            </button>
          </div>
          <div className="agent-messages" ref={agentMessagesRef}>
            {agentMessages.length === 0 ? (
              <div className="agent-empty">问我当前屏幕里的任何问题</div>
            ) : (
              agentMessages.map((message) => (
                <div key={message.id} className={`agent-message ${message.role}`}>
                  {message.role === "assistant" ? (
                    <Streamdown>{message.content}</Streamdown>
                  ) : (
                    message.content
                  )}
                </div>
              ))
            )}
            {agentLoading && <div className="agent-message assistant pending">Thinking...</div>}
          </div>
          <div className="agent-input-row">
            <input
              onPointerDown={(event) => event.stopPropagation()}
              value={agentInput}
              onChange={(event) => setAgentInput(event.target.value)}
              onCompositionStart={() => {
                agentComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                agentComposingRef.current = false;
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (agentComposingRef.current || event.nativeEvent.isComposing)
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }

                if (
                  event.key === "Enter" &&
                  !agentComposingRef.current &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  sendAgentMessage();
                } else if (event.key === "Escape") {
                  setAgentOpen(false);
                }
              }}
              placeholder="Ask about this screen"
              autoFocus
            />
          </div>
        </div>
      )}
      {suggestionPanel && (
        <div
          className={`task-confirm-popover suggestion-popover ${suggestionPanel.error ? "error" : ""}`}
          ref={suggestionPanelRef}
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
        >
          <div className="task-confirm-copy">
            <div className="task-confirm-eyebrow">{suggestionPanel.title}</div>
            <div className="task-confirm-title">{suggestionPanel.description}</div>
            {suggestionPanel.suggestion && (
              <div className="task-confirm-description">{suggestionPanel.suggestion}</div>
            )}
          </div>
          <div className="task-confirm-progress" />
        </div>
      )}
      {taskCandidate && (
        <div
          className="task-confirm-popover"
          ref={taskPopoverRef}
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
        >
          <div className="task-confirm-copy">
            <div className="task-confirm-eyebrow">是否加入 Task？</div>
            <div className="task-confirm-title">{taskCandidate.title}</div>
            {taskCandidate.description && (
              <div className="task-confirm-description">{taskCandidate.description}</div>
            )}
          </div>
          <div className="task-confirm-actions">
            <button
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => mockPreview ? undefined : confirmTask(taskCandidate)}
              disabled={confirming}
            >
              Add
            </button>
            <button
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => mockPreview ? undefined : closeTaskBubble()}
              disabled={confirming}
            >
              Cancel
            </button>
          </div>
          {!mockPreview && <div className="task-confirm-progress" />}
        </div>
      )}
      <div
        id="bubble-circle"
        className={`bubble ${suggestionLoading || agentLoading ? "loading" : ""} ${agentOpen ? "agent-open" : ""}`}
        ref={bubbleRef}
        onClick={handleClick}
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragEnd}
        onMouseEnter={openActionMenu}
        onMouseLeave={scheduleCloseActionMenu}
        title="Open Percent"
      >
        {agentOpen ? (
          <svg className="bubble-icon send-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h13" />
            <path d="m13 6 6 6-6 6" />
          </svg>
        ) : (
          <svg className="bubble-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="7" cy="7" r="2.6" />
            <circle cx="17" cy="17" r="2.6" />
            <path d="M18.5 4.5 5.5 19.5" />
          </svg>
        )}
      </div>
    </div>
  );
}
