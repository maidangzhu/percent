import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as ContextMenu from "@radix-ui/react-context-menu";

// ---- 配置 ----

const API_BASE = "http://localhost:3000";

interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

// ---- 类型 ----

// GET /logs 返回的每行
interface LogRow {
  id: number;
  occurred_at: string;
  app_name: string;
  app_bundle_id: string;
  is_send: boolean;
  is_wechat: boolean;
  screenshot_path: string | null;
  // JOIN 字段（可能为 null）
  turn_id: number | null;
  topic: string | null;
  partner_name: string | null;
  person_id: number | null;
}

// GET /people 返回的每个联系人
interface PersonSummary {
  id: number;
  name: string;
  client_app: string;
  created_at: string;
  updated_at: string;
  turn_count: number;
  last_chat_at: string | null;
}

// GET /people/:id 返回的详情（含 turns）
interface Message {
  role: "self" | "other";
  content: string;
}

interface TurnDetail {
  id: number;
  log_id: number;
  topic: string;
  captured_at: string;
  messages: Message[] | null;
}

interface PersonDetail extends PersonSummary {
  turns: TurnDetail[];
}

interface TaskRow {
  id: number;
  person_id: number | null;
  person_name: string | null;
  title: string;
  description: string;
  due_at: string | null;
  status: "pending" | "completed";
  evidence: string;
  created_at: string;
  completed_at: string | null;
}

type MenuKey = "logs" | "people" | "tasks";

const MENU_ITEMS: { key: MenuKey; label: string; icon: string }[] = [
  { key: "logs",   label: "Logs",   icon: "⌘" },
  { key: "people", label: "People", icon: "◎" },
  { key: "tasks",  label: "Task",   icon: "✓" },
];

// ---- 根组件 ----

export default function MainWindow() {
  const [activeKey, setActiveKey] = useState<MenuKey>("logs");
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [screenshotEnabled, setScreenshotEnabled] = useState(false);

  const loadLogs = async () => {
    try {
      const resp = await fetch(`${API_BASE}/logs?limit=100&offset=0`);
      const json = await resp.json() as ApiResponse<LogRow[]>;
      setLogs(json.data ?? []);
    } catch (e) {
      console.error("[main] GET /logs error:", e);
    }
  };

  const loadPeople = async () => {
    try {
      const resp = await fetch(`${API_BASE}/people`);
      const json = await resp.json() as ApiResponse<PersonSummary[]>;
      setPeople(json.data ?? []);
    } catch (e) {
      console.error("[main] GET /people error:", e);
    }
  };

  const loadTasks = async () => {
    try {
      const resp = await fetch(`${API_BASE}/tasks`);
      const json = await resp.json() as ApiResponse<TaskRow[]>;
      setTasks(json.data ?? []);
    } catch (e) {
      console.error("[main] GET /tasks error:", e);
    }
  };

  useEffect(() => {
    loadLogs();
    loadPeople();
    loadTasks();
    invoke<boolean>("get_screenshot_enabled").then(setScreenshotEnabled);

    const unlistenEnter = listen("enter-pressed", () => {
      // 延迟一点等后端写完
      setTimeout(loadLogs, 1000);
    });
    const unlistenAI = listen("ai-result-updated", () => {
      loadLogs();
      loadPeople();
      loadTasks();
    });
    const unlistenTasks = listen("tasks-updated", () => {
      loadTasks();
    });
    return () => {
      unlistenEnter.then((f) => f());
      unlistenAI.then((f) => f());
      unlistenTasks.then((f) => f());
    };
  }, []);

  const toggleScreenshot = async () => {
    const next = !screenshotEnabled;
    await invoke("set_screenshot_enabled", { enabled: next });
    setScreenshotEnabled(next);
  };

  return (
    <div className="main-layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="app-icon">%</span>
          <span className="app-title">Percent Tracker</span>
        </div>
        <nav className="sidebar-nav">
          {MENU_ITEMS.map((item) => (
            <button
              key={item.key}
              className={`menu-item ${activeKey === item.key ? "active" : ""}`}
              onClick={() => setActiveKey(item.key)}
            >
              <span className="menu-icon">{item.icon}</span>
              <span className="menu-label">{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="content">
        {activeKey === "logs" && (
          <LogsView
            logs={logs}
            onRefresh={() => { loadLogs(); loadPeople(); }}
            screenshotEnabled={screenshotEnabled}
            onToggleScreenshot={toggleScreenshot}
          />
        )}
        {activeKey === "people" && (
          <PeopleView people={people} onRefresh={() => { loadPeople(); loadTasks(); }} />
        )}
        {activeKey === "tasks" && (
          <TasksView tasks={tasks} onRefresh={loadTasks} />
        )}
      </main>
    </div>
  );
}

function TasksView({ tasks, onRefresh }: { tasks: TaskRow[]; onRefresh: () => void }) {
  const [newTitle, setNewTitle] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [mockPreviewOn, setMockPreviewOn] = useState(false);

  const pendingCount = tasks.filter((task) => task.status === "pending").length;

  const createTask = async () => {
    if (!newTitle.trim()) return;
    await fetch(`${API_BASE}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newTitle.trim() }),
    });
    setNewTitle("");
    onRefresh();
  };

  const updateTask = async (id: number, body: Partial<TaskRow>) => {
    await fetch(`${API_BASE}/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    onRefresh();
  };

  const deleteTask = async (id: number) => {
    await fetch(`${API_BASE}/tasks/${id}`, { method: "DELETE" });
    onRefresh();
  };

  const startEdit = (task: TaskRow) => {
    setEditingId(task.id);
    setEditingTitle(task.title);
  };

  const saveEdit = async () => {
    if (!editingId || !editingTitle.trim()) return;
    await updateTask(editingId, { title: editingTitle.trim() } as Partial<TaskRow>);
    setEditingId(null);
    setEditingTitle("");
  };

  useEffect(() => {
    invoke("set_mock_task_preview", { enabled: mockPreviewOn }).catch((e) =>
      console.error("[tasks] set mock preview failed:", e)
    );
  }, [mockPreviewOn]);

  return (
    <div className="tasks-view">
      <header className="content-header">
        <div>
          <h1>Task</h1>
          <p className="subtitle">{pendingCount} pending &nbsp;·&nbsp; {tasks.length} total</p>
        </div>
        <div className="header-actions">
          <label className="mock-switch-label" title="只用于预览右下角 AI 确认气泡，不会创建任务">
            <span>Mock 测试 Task</span>
            <button
              type="button"
              className={`mock-switch ${mockPreviewOn ? "on" : ""}`}
              role="switch"
              aria-checked={mockPreviewOn}
              onClick={() => setMockPreviewOn((value) => !value)}
            >
              <span />
            </button>
          </label>
          <button className="refresh-btn" onClick={onRefresh}>Refresh</button>
        </div>
      </header>

      <div className="task-compose">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") createTask(); }}
          placeholder="新增待办"
        />
        <button onClick={createTask}>Add</button>
      </div>

      <div className="task-list">
        {tasks.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">✓</div>
            <p>暂无待办</p>
          </div>
        ) : (
          tasks.map((task) => (
            <div key={task.id} className={`task-item ${task.status}`}>
              <button
                className={`task-check ${task.status === "completed" ? "checked" : ""}`}
                onClick={() =>
                  updateTask(task.id, {
                    status: task.status === "completed" ? "pending" : "completed",
                  } as Partial<TaskRow>)
                }
                title={task.status === "completed" ? "恢复" : "完成"}
              >
                ✓
              </button>
              <div className="task-main">
                {editingId === task.id ? (
                  <input
                    className="task-title-input"
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); }}
                    autoFocus
                  />
                ) : (
                  <button className="task-title" onClick={() => startEdit(task)}>
                    {task.title}
                  </button>
                )}
                <div className="task-meta">
                  {task.person_name ? `来自 ${task.person_name}` : "手动创建"}
                  {task.due_at ? ` · ${new Date(task.due_at).toLocaleString()}` : ""}
                </div>
                {task.evidence && <div className="task-evidence">{task.evidence}</div>}
              </div>
              <div className="task-actions">
                {editingId === task.id && <button onClick={saveEdit}>Save</button>}
                <button onClick={() => deleteTask(task.id)}>Delete</button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---- Logs 视图 ----

function LogsView({
  logs,
  onRefresh,
  screenshotEnabled,
  onToggleScreenshot,
}: {
  logs: LogRow[];
  onRefresh: () => void;
  screenshotEnabled: boolean;
  onToggleScreenshot: () => void;
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detailCache, setDetailCache] = useState<Record<number, TurnDetail & { partner_name: string }>>({});
  const sendCount = logs.filter((l) => l.is_send).length;

  const loadDetail = async (log: LogRow) => {
    if (!log.person_id || !log.turn_id) return;
    if (detailCache[log.id]) return; // 已缓存

    try {
      const resp = await fetch(`${API_BASE}/people/${log.person_id}`);
      const json = await resp.json() as ApiResponse<PersonDetail>;
      const person = json.data;
      const turn = person.turns.find((t) => t.id === log.turn_id);
      if (turn) {
        setDetailCache((prev) => ({
          ...prev,
          [log.id]: { ...turn, partner_name: person.name },
        }));
      }
    } catch (e) {
      console.error("[main] GET /people/:id error:", e);
    }
  };

  const handleRowClick = (log: LogRow) => {
    const isExpanded = expandedId === log.id;
    setExpandedId(isExpanded ? null : log.id);
    if (!isExpanded && log.turn_id) {
      loadDetail(log);
    }
  };

  return (
    <div className="logs-view">
      <header className="content-header">
        <div>
          <h1>Logs</h1>
          <p className="subtitle">
            {logs.length} total &nbsp;·&nbsp;
            <span className="badge-send">{sendCount} sends</span>
            &nbsp;·&nbsp;
            <span className="badge-newline">{logs.length - sendCount} newlines</span>
          </p>
        </div>
        <div className="header-actions">
          <label className="toggle-label" title="截图调试：每次按 Enter 时截取当前屏幕，保存到日志目录的 screenshots 文件夹">
            <span className="toggle-text">截图调试</span>
            <span
              className={`toggle-switch ${screenshotEnabled ? "on" : ""}`}
              onClick={onToggleScreenshot}
            />
          </label>
        <button className="refresh-btn" onClick={onRefresh}>Refresh</button>
        </div>
      </header>

      <div className="logs-table-wrapper">
        {logs.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">⌘</div>
            <p>No logs yet</p>
            <p className="hint">Press Enter anywhere to start tracking</p>
          </div>
        ) : (
          <table className="logs-table">
            <thead>
              <tr>
                <th style={{ width: 60 }}>#</th>
                <th style={{ width: 90 }}>Type</th>
                <th style={{ width: 120 }}>App</th>
                <th>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
                const hasAI = !!log.turn_id;
                const isExpanded = expandedId === log.id;
                const detail = detailCache[log.id];

                return (
                  <>
                    <tr
                      key={log.id}
                      className={`log-row ${hasAI ? "has-ai" : ""} ${isExpanded ? "expanded" : ""}`}
                      onClick={() => handleRowClick(log)}
                    >
                      <td className="cell-id">#{log.id}</td>
                      <td>
                        <span className={`tag ${log.is_send ? "tag-send" : "tag-newline"}`}>
                          {log.is_send ? "Send" : "Newline"}
                        </span>
                      </td>
                      <td className="cell-app" title={log.app_bundle_id}>
                        {log.app_name || "—"}
                      </td>
                      <td className="cell-time">
                        <span>{new Date(log.occurred_at).toLocaleString()}</span>
                        {hasAI && (
                          <span className="ai-badge">
                            {isExpanded ? "▲" : "▼"} {log.partner_name}
                          </span>
                        )}
                      </td>
                    </tr>
                    {isExpanded && hasAI && (
                      <tr key={`${log.id}-detail`} className="detail-row">
                        <td colSpan={4}>
                          {detail ? (
                            <DetailPanel
                              partnerName={detail.partner_name}
                              topic={detail.topic}
                              capturedAt={detail.captured_at}
                              messages={detail.messages ?? []}
                            />
                          ) : (
                            <div className="detail-panel" style={{ padding: "12px", color: "#888" }}>
                              加载中…
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---- 详情面板 ----

function DetailPanel({
  partnerName,
  topic,
  capturedAt,
  messages,
}: {
  partnerName: string;
  topic: string;
  capturedAt: string;
  messages: Message[];
}) {
  return (
    <div className="detail-panel">
      <div className="detail-meta" style={{ marginBottom: 8, fontSize: 12, color: "#888" }}>
        <span>与 <strong>{partnerName}</strong> 的对话</span>
        &nbsp;·&nbsp;
        <span>{topic}</span>
        &nbsp;·&nbsp;
        <span>{new Date(capturedAt).toLocaleString()}</span>
      </div>
      <div className="detail-messages">
        {messages.map((m, i) => (
          <div key={i} className={`message-bubble ${m.role}`}>
            <span className="message-role">{m.role === "self" ? "我" : partnerName}</span>
            <span className="message-content">{m.content}</span>
          </div>
        ))}
      </div>
      <details className="detail-json">
        <summary>Raw JSON</summary>
        <pre>{JSON.stringify({ partner: partnerName, topic, captured_at: capturedAt, messages }, null, 2)}</pre>
      </details>
    </div>
  );
}

// ---- 回复建议类型 ----

type SuggestStyle = "chat_master" | "cautious" | "flirty" | "icebreaker";

const SUGGEST_STYLES: { key: SuggestStyle; label: string; desc: string }[] = [
  { key: "chat_master", label: "聊天达人", desc: "轻松幽默，让对方忍不住回复" },
  { key: "cautious",    label: "谨言慎行", desc: "得体稳重，不卑不亢" },
  { key: "flirty",      label: "暧昧拉扯", desc: "若即若离，留足想象空间" },
  { key: "icebreaker",  label: "打破尬聊", desc: "化解僵局，重新激活对话" },
];

// ---- People 视图 ----

function PeopleView({ people, onRefresh }: { people: PersonSummary[]; onRefresh: () => void }) {
  const [selectedId, setSelectedId] = useState<number | null>(
    people[0]?.id ?? null
  );
  const [personDetail, setPersonDetail] = useState<PersonDetail | null>(null);
  const [loading, setLoading] = useState(false);

  // 回复建议状态
  const [selectedStyle, setSelectedStyle] = useState<SuggestStyle>("chat_master");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const loadPersonDetail = async (id: number) => {
    setLoading(true);
    try {
      const resp = await fetch(`${API_BASE}/people/${id}`);
      const json = await resp.json() as ApiResponse<PersonDetail>;
      setPersonDetail(json.data);
    } catch (e) {
      console.error("[main] GET /people/:id error:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedId != null) {
      loadPersonDetail(selectedId);
    }
  }, [selectedId]);

  useEffect(() => {
    if (selectedId == null && people.length > 0) {
      setSelectedId(people[0].id);
    }
  }, [people]);

  const handleSelectPerson = (id: number) => {
    setSelectedId(id);
    setPersonDetail(null);
    setSuggestions([]);
  };

  const handleDeletePerson = async (person: PersonSummary) => {
    const ok = window.confirm(`删除 ${person.name} 及其所有聊天记录？`);
    if (!ok) return;

    try {
      const resp = await fetch(`${API_BASE}/people/${person.id}`, { method: "DELETE" });
      const json = await resp.json() as ApiResponse<{ ok: boolean }>;
      if (!resp.ok || json.code !== 0) {
        console.error("[people] delete error:", json.message);
        return;
      }

      if (selectedId === person.id) {
        setSelectedId(null);
        setPersonDetail(null);
        setSuggestions([]);
      }
      onRefresh();
    } catch (e) {
      console.error("[people] delete request failed:", e);
    }
  };

  const handleGenerateSuggestions = async () => {
    if (!selectedId) return;
    setSuggestLoading(true);
    setSuggestions([]);
    try {
      const resp = await fetch(`${API_BASE}/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ person_id: selectedId, style: selectedStyle }),
      });
      const json = await resp.json() as ApiResponse<{ suggestions: string[] }>;
      if (!resp.ok || json.code !== 0) {
        console.error("[suggest] error:", json.message);
      } else {
        setSuggestions(json.data.suggestions);
      }
    } catch (e) {
      console.error("[suggest] request failed:", e);
    } finally {
      setSuggestLoading(false);
    }
  };

  const handleCopy = (text: string, index: number) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 1500);
    });
  };

  return (
    <div className="people-layout">
      {/* 左侧人物列表 */}
      <div className="people-list">
        <div className="people-list-header">
          <span>联系人</span>
          <button className="refresh-btn-sm" onClick={onRefresh}>Refresh</button>
        </div>
        {people.length === 0 ? (
          <div className="people-empty">暂无记录</div>
        ) : (
          people.map((p) => (
            <ContextMenu.Root key={p.id}>
              <ContextMenu.Trigger asChild>
                <button
                  className={`person-item ${selectedId === p.id ? "active" : ""}`}
                  onClick={() => handleSelectPerson(p.id)}
                >
                  <div className="person-avatar">{p.name.charAt(0).toUpperCase()}</div>
                  <div className="person-info">
                    <div className="person-name">{p.name}</div>
                    <div className="person-meta">{p.client_app} · {p.turn_count} 次对话</div>
                  </div>
                </button>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className="context-menu-content" alignOffset={4}>
                  <ContextMenu.Item
                    className="context-menu-item danger"
                    onSelect={() => handleDeletePerson(p)}
                  >
                    删除联系人
                  </ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          ))
        )}
      </div>

      {/* 右侧详情 */}
      <div className="person-detail">
        {loading ? (
          <div className="empty-state">
            <p style={{ color: "#888" }}>加载中…</p>
          </div>
        ) : personDetail ? (
          <>
            <div className="person-detail-header">
              <div className="person-avatar-lg">{personDetail.name.charAt(0).toUpperCase()}</div>
              <div>
                <h2>{personDetail.name}</h2>
                <p className="subtitle">
                  {personDetail.client_app}
                  &nbsp;·&nbsp;首次 {personDetail.created_at.slice(0, 10)}
                  &nbsp;·&nbsp;最近 {personDetail.updated_at.slice(0, 10)}
                </p>
              </div>
            </div>

            {/* 回复建议区 */}
            <div className="suggest-section">
              <div className="suggest-styles">
                {SUGGEST_STYLES.map((s) => (
                  <button
                    key={s.key}
                    className={`style-btn ${selectedStyle === s.key ? "active" : ""}`}
                    onClick={() => { setSelectedStyle(s.key); setSuggestions([]); }}
                    title={s.desc}
                  >
                    {s.label}
                  </button>
                ))}
                <button
                  className={`generate-btn ${suggestLoading ? "loading" : ""}`}
                  onClick={handleGenerateSuggestions}
                  disabled={suggestLoading}
                >
                  {suggestLoading ? "生成中…" : "生成回复建议"}
                </button>
              </div>

              {suggestions.length > 0 && (
                <div className="suggestions-list">
                  {suggestions.map((s, i) => (
                    <div key={i} className="suggestion-card">
                      <span className="suggestion-text">{s}</span>
                      <button
                        className={`copy-btn ${copiedIndex === i ? "copied" : ""}`}
                        onClick={() => handleCopy(s, i)}
                      >
                        {copiedIndex === i ? "已复制" : "复制"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="turns-timeline">
              {(personDetail.turns ?? []).map((turn) => (
                <div key={turn.id} className="turn-card">
                  <div className="turn-meta">
                    <span className="turn-time">{new Date(turn.captured_at).toLocaleString()}</span>
                    <span className="turn-topic">{turn.topic}</span>
                  </div>
                  <div className="turn-messages">
                    {(turn.messages ?? []).map((m, i) => (
                      <div key={i} className={`message-bubble ${m.role}`}>
                        <span className="message-role">
                          {m.role === "self" ? "我" : personDetail.name}
                        </span>
                        <span className="message-content">{m.content}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-icon">◎</div>
            <p>选择一个联系人</p>
            <p className="hint">在微信中聊天并开启截图调试后，AI 会自动识别并归档</p>
          </div>
        )}
      </div>
    </div>
  );
}
