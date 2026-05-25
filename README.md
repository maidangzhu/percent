# Percent — 产品需求文档

> 版本：v0.1 · 2026-05-22

---

## 一、产品定位

**Percent** 是一个运行在 macOS 上的聊天参谋工具，帮助用户在与客户、朋友或同事聊天时获得 AI 辅助建议，解决"不知道怎么回复"的问题。

典型场景：
- 与客户在微信聊天，感觉节奏不对，不知道怎么推进
- 与喜欢的人聊天，不知道怎么回才不尬
- 在飞书与领导沟通，领导质疑你，不知道该怎么回应

---

## 二、系统架构

```
┌─────────────────────────────────────────┐
│  macOS 客户端（Tauri）                   │
│                                          │
│  Rust 层（系统级）                        │
│  · 全局键盘监听（Enter 键）               │
│  · 截图（screencapture）                 │
│  · 获取前台 App 信息（osascript）         │
│  · emit 事件给 TS 层                     │
│                                          │
│  TS 层（bubble.tsx，常驻后台）            │
│  · 收到事件后，上报给后端 API             │
│  · 触发 AI 分析（通过后端）               │
│  · 展示分析结果                          │
│                                          │
│  main 窗口                               │
│  · Logs 页面：展示原始日志               │
│  · People 页面：按联系人聚合展示          │
└──────────────┬──────────────────────────┘
               │ HTTP API
┌──────────────▼──────────────────────────┐
│  后端（Node.js + Hono）                  │
│                                          │
│  POST /logs        — 上报 Enter 事件     │
│  GET  /logs        — 查询日志列表         │
│  POST /analyze     — 截图 AI 分析         │
│  GET  /people      — 联系人列表           │
│  GET  /people/:id  — 联系人详情+聊天记录  │
└──────────────┬──────────────────────────┘
               │ PostgreSQL (Neon)
┌──────────────▼──────────────────────────┐
│  数据库（见第三节）                       │
└─────────────────────────────────────────┘
```

---

## 三、数据库表设计

### `logs` — 原始 Enter 事件
| 字段 | 类型 | 说明 |
|------|------|------|
| id | BIGSERIAL PK | |
| occurred_at | TIMESTAMPTZ | 按键时间 |
| app_name | TEXT | 前台应用名 |
| app_bundle_id | TEXT | 应用 bundle ID |
| is_send | BOOLEAN | 是否判定为"发送消息" |
| is_wechat | BOOLEAN | 是否是微信 |
| screenshot_path | TEXT | 截图本地路径（可选）|
| created_at | TIMESTAMPTZ | 写入时间 |

### `people` — 聊天对象
| 字段 | 类型 | 说明 |
|------|------|------|
| id | BIGSERIAL PK | |
| name | TEXT | 备注名/显示名 |
| client_app | TEXT | 来自哪个 App |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | 最近一次聊天时间 |
| UNIQUE | (name, client_app) | 同名同app去重 |

### `chat_turns` — 每次 AI 分析的聊天快照
| 字段 | 类型 | 说明 |
|------|------|------|
| id | BIGSERIAL PK | |
| log_id | BIGINT FK→logs | 对应哪次 Enter |
| person_id | BIGINT FK→people | 对应哪个联系人 |
| topic | TEXT | AI 识别的话题 |
| captured_at | TIMESTAMPTZ | 截图时间 |
| raw_ai_response | JSONB | 原始 AI 返回 |
| created_at | TIMESTAMPTZ | |

### `chat_messages` — turn 内的单条消息
| 字段 | 类型 | 说明 |
|------|------|------|
| id | BIGSERIAL PK | |
| turn_id | BIGINT FK→chat_turns | |
| role | TEXT | `self` 或 `other` |
| content | TEXT | 消息内容 |
| seq | INT | 顺序 |
| created_at | TIMESTAMPTZ | |

---

## 四、当前已实现功能

- [x] 全局 Enter 键监听（Rust，device_query 轮询）
- [x] 识别前台 App（osascript + System Events）
- [x] 判断是否为"发送消息"行为（应用白名单）
- [x] 截图（macOS screencapture，无快门声）
- [x] 浮动气泡 UI（右下角，可拖动，永远置顶）
- [x] 主窗口：Logs 页 + People 页
- [x] Logs 行点击展开 AI 分析详情
- [x] 后端 API：/logs、/analyze、/people
- [x] 数据库建表（migration 管理）
- [x] AI 多模态分析（Kimi k2.6，function calling）
- [x] 聊天记录写库（people + chat_turns + chat_messages）

---

## 五、待实现功能

### 5.1 客户端对接后端（优先级：高）

当前客户端数据仍在本地（Rust log store + sessions.json），需要改为全部走后端 API：

- [ ] bubble.tsx：Enter 事件先 POST /logs，拿到 log_id，再 POST /analyze（带截图 base64）
- [ ] main 窗口 Logs 页：数据从 GET /logs 获取，不再从 Rust invoke
- [ ] main 窗口 People 页：数据从 GET /people + GET /people/:id 获取

### 5.2 聊天回复建议（被动式，优先级：高）

用户主动触发，AI 基于聊天历史生成回复建议：

- [ ] `POST /suggest` 接口：传入 person_id，后端拉取该联系人近期聊天记录，调 AI 生成 3 条回复建议
- [ ] 客户端：People 页联系人详情里加"生成建议"按钮
- [ ] 展示建议卡片，支持复制

### 5.3 会话连续性（优先级：中）

- [ ] 同一个 partner 的多次 turn，在 People 页按时间顺序完整展示
- [ ] 识别重复消息（相邻两次截图内容重叠时去重）

### 5.4 主动式建议（优先级：低，后续规划）

- [ ] AI 持续观察截图，发现对话进入某种状态（如对方等待回复超过 N 秒）时主动推送建议
- [ ] 需要设计 Agent loop 机制

### 5.5 多应用支持（优先级：中）

当前仅微信触发截图分析，后续扩展：
- [ ] 飞书（Lark）
- [ ] 钉钉
- [ ] 可在设置页配置哪些 App 开启分析

### 5.6 用户体系（优先级：低，后续规划）

- [ ] 目前无用户体系，所有数据共享
- [ ] 后续接入时需要给所有表加 `user_id` 字段

---

## 六、Migration 规范

每次数据库变更必须通过 migration 文件执行：

1. 在 `apps/server/src/db/migrations/` 新建 `NNN_description.sql`（NNN 递增）
2. 执行 `npm run migrate`（在 `apps/server/` 目录下）
3. 将 migration 文件提交到 git
4. **禁止** 直接修改已执行的 migration 文件

---

## 七、本地开发

```bash
# 启动后端
cd apps/server
npm run dev        # http://localhost:3000

# 执行 migration
npm run migrate

# 启动客户端
cd apps/client
npm run tauri:dev
```

环境变量：
- `apps/server/.env`：`DATABASE_URL`、`LLM_API_KEY`、`PORT`
- `apps/client/.env`：`VITE_LLM_API_KEY`（临时，后续 AI 调用移到后端后删除）
