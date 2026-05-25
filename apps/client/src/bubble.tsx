import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

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

// ---- 截图转 base64（通过 Rust command，避免 fs scope 限制）----

async function imagePathToBase64(path: string): Promise<string> {
  return await invoke<string>("read_file_base64", { path });
}

// ---- 核心流程 ----

async function processEnterEvent(event: EnterEvent, onTaskCandidate: TaskCandidateHandler) {
  const pipelineStartedAt = performance.now();
  console.log("[bubble] pipeline.start", JSON.stringify(event));

  // 1. POST /logs — 创建日志条目，拿到 log_id
  let logId: number;
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
      return;
    }
    const logData = await logResp.json() as ApiResponse<{ id: number }>;
    logId = logData.data.id;
    console.log("[bubble] logs.create.success", {
      log_id: logId,
      duration_ms: Math.round(performance.now() - startedAt),
    });
  } catch (e) {
    console.error("[bubble] POST /logs error:", e);
    return;
  }

  // 2. 只有微信 + 有截图才触发 AI 分析
  if (!event.is_wechat || !event.screenshot_path) {
    console.log("[bubble] analyze.skip", {
      log_id: logId,
      is_wechat: event.is_wechat,
      has_screenshot: Boolean(event.screenshot_path),
    });
    return;
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
    return;
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
        app_name: event.app_name,
        image_base64: imageBase64,
      }),
    });
    if (!analyzeResp.ok) {
      console.error("[bubble] POST /analyze failed:", analyzeResp.status, await analyzeResp.text());
      return;
    }
    const analyzeData = await analyzeResp.json() as ApiResponse<
      {
        is_chat: boolean;
        person?: { id: number; name: string };
        turn?: { id: number; topic: string };
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
    await invoke("report_ai_result", {
      entryId: event.entry_id,
      partner: result.person?.name ?? "",
      topic: result.turn?.topic ?? "",
      isChat: result.is_chat,
    });
    console.log("[bubble] pipeline.success", {
      log_id: logId,
      trace_id: result.trace_id,
      duration_ms: Math.round(performance.now() - pipelineStartedAt),
    });
  } catch (e) {
    console.error("[bubble] POST /analyze error:", e);
  }
}

// ---- Bubble UI ----

export default function Bubble() {
  const containerRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const taskPopoverRef = useRef<HTMLDivElement>(null);
  const [taskCandidate, setTaskCandidate] = useState<TaskCandidate | null>(null);
  const [mockPreview, setMockPreview] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<number | null>(null);

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
        const elements = [bubbleRef.current, taskPopoverRef.current].filter(
          (element): element is HTMLDivElement => Boolean(element)
        );
        const regions = elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return {
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
  }, [taskCandidate]);

  useEffect(() => {
    clearAutoCreateTimer();
    if (taskCandidate && !mockPreview) {
      timerRef.current = window.setTimeout(() => {
        confirmTask(taskCandidate);
      }, 6500);
    }
  }, [taskCandidate, mockPreview]);

  function animatePulse() {
    const el = document.getElementById("bubble-circle");
    if (!el) return;
    el.classList.remove("pulse");
    void el.offsetWidth;
    el.classList.add("pulse");
    setTimeout(() => el.classList.remove("pulse"), 300);
  }

  const handleClick = async () => {
    await invoke("show_main_window");
  };

  const handleDragStart = async (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    await getCurrentWindow().startDragging().catch((e) =>
      console.error("[bubble] start dragging failed:", e)
    );
  };

  return (
    <div className="bubble-container" ref={containerRef}>
      {taskCandidate && (
        <div
          className="task-confirm-popover"
          ref={taskPopoverRef}
          onPointerDown={handleDragStart}
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
        className="bubble"
        ref={bubbleRef}
        onClick={handleClick}
        onPointerDown={handleDragStart}
        title="Open Percent"
      >
        <svg className="bubble-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="7" cy="7" r="2.6" />
          <circle cx="17" cy="17" r="2.6" />
          <path d="M18.5 4.5 5.5 19.5" />
        </svg>
      </div>
    </div>
  );
}
