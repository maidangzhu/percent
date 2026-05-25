import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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

// ---- 截图转 base64（通过 Rust command，避免 fs scope 限制）----

async function imagePathToBase64(path: string): Promise<string> {
  return await invoke<string>("read_file_base64", { path });
}

// ---- 核心流程 ----

async function processEnterEvent(event: EnterEvent) {
  console.log("[bubble] enter-pressed:", JSON.stringify(event));

  // 1. POST /logs — 创建日志条目，拿到 log_id
  let logId: number;
  try {
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
    const logData = await logResp.json() as { data: { id: number } };
    logId = logData.data.id;
    console.log(`[bubble] log #${logId} created`);
  } catch (e) {
    console.error("[bubble] POST /logs error:", e);
    return;
  }

  // 2. 只有微信 + 有截图才触发 AI 分析
  if (!event.is_wechat || !event.screenshot_path) {
    console.log("[bubble] not wechat or no screenshot, skip analyze");
    return;
  }

  // 3. 读取截图 → base64
  let imageBase64: string;
  try {
    imageBase64 = await imagePathToBase64(event.screenshot_path);
    console.log(`[bubble] screenshot loaded, size: ${imageBase64.length} chars`);
  } catch (e) {
    console.error("[bubble] read screenshot failed:", e);
    return;
  }

  // 4. POST /analyze — 让后端调 AI 分析
  try {
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
    const analyzeData = await analyzeResp.json() as {
      data: {
        is_chat: boolean;
        person?: { id: number; name: string };
        turn?: { id: number; topic: string };
        messages?: { role: string; content: string }[];
      };
    };
    const result = analyzeData.data;
    console.log(`[bubble] analyze result: is_chat=${result.is_chat}, partner=${result.person?.name ?? "—"}`);

    // 5. 回传给 Rust（更新内存中的 log store，触发 ai-result-updated 事件刷新 UI）
    await invoke("report_ai_result", {
      entryId: event.entry_id,
      partner: result.person?.name ?? "",
      topic: result.turn?.topic ?? "",
      isChat: result.is_chat,
    });
  } catch (e) {
    console.error("[bubble] POST /analyze error:", e);
  }
}

// ---- Bubble UI ----

export default function Bubble() {
  const countRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    invoke<number>("get_enter_count").then((n) => {
      countRef.current = n;
      updateBadge(n);
    });

    const unlistenCount = listen<number>("count-updated", (e) => {
      countRef.current = e.payload;
      updateBadge(e.payload);
      animatePulse();
    });

    // 核心：监听 enter-pressed，走后端 API pipeline
    const unlistenEnter = listen<EnterEvent>("enter-pressed", (e) => {
      processEnterEvent(e.payload).catch((err) =>
        console.error("[bubble] pipeline error:", err)
      );
    });

    return () => {
      unlistenCount.then((f) => f());
      unlistenEnter.then((f) => f());
    };
  }, []);

  function updateBadge(count: number) {
    const badge = document.getElementById("bubble-badge");
    if (!badge) return;
    if (count > 0) {
      badge.textContent = String(count);
      badge.style.display = "flex";
    } else {
      badge.style.display = "none";
    }
  }

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

  return (
    <div className="bubble-container" data-tauri-drag-region ref={containerRef}>
      <div id="bubble-circle" className="bubble" onClick={handleClick}>
        <span className="bubble-icon">&#9166;</span>
        <span
          id="bubble-badge"
          className="bubble-count"
          style={{ display: "none" }}
        />
      </div>
    </div>
  );
}
