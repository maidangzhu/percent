# Percent

Percent 的名字来自卢广仲的《几分之几 (You Complete Me)》。

它是一个运行在 macOS 上的 AI 伙伴，先从聊天场景开始：当你不知道该怎么回复、担心话说得不合适、读不懂对方的情绪，或者需要在客户沟通里仔细斟酌每一句话时，Percent 会站在屏幕旁边，帮你理解上下文并给出回复建议。

但 Percent 不只是一个“帮你回消息”的工具。它还会从微信聊天上下文里识别那些隐含的 todo：比如一句“明天下午你过来看看”、一句“回头把资料发我”、一句“有空约时间”。这些信息很容易淹没在聊天记录里，Percent 会把它们整理成 Task，让你不再忘记聊天里包含的重要事项。

## 产品方向

Percent 想做的是一个能感知用户处境和情绪的 Agent。

很多聊天并不是简单的信息交换。你可能在和喜欢的人聊天，害怕自己说错话，担心气氛变尴尬，看不明白对方真正的意思；也可能在和客户谈合作，每一句话都要兼顾礼貌、推进、边界和成交机会。

Percent 的目标不是替你说话，而是帮你看清当前对话的节奏、关系和风险，然后给你一个更稳妥、更自然的选择。

典型场景：

- 和客户沟通时，生成更得体、更能推进合作的回复建议。
- 和喜欢的人聊天时，缓解“不知道怎么回”的压力，避免尬聊。
- 从微信聊天中识别隐含待办，自动整理成 Task。
- 按联系人聚合聊天上下文，形成连续、去重后的聊天流。
- 在当前屏幕语境下与 AI Agent 对话，询问“我现在该怎么回”“对方可能是什么意思”。

## 当前能力

- macOS 常驻浮动气泡，可拖拽、置顶。
- 支持全局快捷键触发截图和多模态分析。
- 识别微信聊天对象，按 People 聚合聊天记录。
- 合并多次截图产生的重叠聊天内容，尽量展示连续聊天流。
- 生成回复建议，并自动复制到剪贴板。
- 识别聊天里的待办事项，支持确认后写入 Task。
- Task 支持增删改查、完成、删除。
- 内置 Agent 聊天面板，可基于当前屏幕上下文问答。
- 首次进入会引导开启屏幕录制和辅助功能权限。
- 支持登录注册，账号和会话走 Better Auth。

## 隐私原则

聊天数据是敏感数据，所以 Percent 采用 local-first 的数据设计：

- People、聊天记录、Task、Logs、截图缓存都保存在本机。
- 本地数据库默认位于 `~/.percent-tracker/percent.db`。
- Better Auth 的用户、账号、会话和验证数据保存在 Neon。
- Neon 默认使用独立的 `auth` schema，不保存聊天内容。

也就是说，登录系统是云端的，但聊天上下文和任务信息仍然留在用户本地。

## 系统架构

```text
macOS 客户端 (Tauri)
├─ Rust 层
│  ├─ 全局快捷键监听
│  ├─ 屏幕截图
│  ├─ 前台应用识别
│  └─ macOS 权限检测
│
├─ React 层
│  ├─ 右下角浮动气泡
│  ├─ AI 回复建议面板
│  ├─ Agent 聊天面板
│  └─ 主窗口：Logs / People / Task / Settings
│
└─ HTTP API
   └─ Node.js + Hono 后端
      ├─ 本地 SQLite：People / Chat / Task / Logs
      ├─ Neon PostgreSQL：Better Auth
      └─ AI SDK：多模态分析与回复生成
```

## 数据边界

本地 SQLite：

- `logs`：截图和快捷键触发记录
- `people`：聊天对象
- `chat_turns`：截图分析得到的聊天快照
- `chat_messages`：去重后的聊天消息
- `tasks`：从聊天上下文里识别出的待办

远程 Neon：

- `User`
- `Session`
- `Account`
- `Verification`

## 本地开发

安装依赖：

```bash
pnpm install
```

启动后端和客户端：

```bash
pnpm dev
```

单独启动后端：

```bash
pnpm --filter percent-server dev
```

单独启动客户端：

```bash
pnpm --filter percent-tracker dev
```

## 环境变量

后端环境变量可放在 `apps/server/.env`，也会兼容读取项目根目录 `.env`：

```bash
LLM_API_KEY=
PORT=3000

AUTH_DATABASE_URL=
AUTH_DATABASE_SCHEMA=auth
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000
```

`AUTH_DATABASE_URL`、`NEON_DATABASE_URL`、旧的 `DATABASE_URL` 都可以作为 auth 数据库连接来源。业务数据不会写入 Neon。

同步 Better Auth 表：

```bash
pnpm --filter percent-server run auth:db:push
```

## 常用命令

```bash
# 后端类型检查和构建
pnpm --filter percent-server build

# 前端类型检查和构建
pnpm --filter percent-tracker build

# 生成 Better Auth Prisma Client
pnpm --filter percent-server run auth:generate
```

## 项目状态

Percent 仍处于早期阶段。当前重点是把“屏幕感知 + 聊天理解 + 本地记忆 + 行动建议”这条链路打通，并在真实聊天场景里持续调整体验。

长期目标是让它从一个回复建议工具，逐渐变成一个理解你当前处境、尊重你隐私、能帮你处理关系和信息压力的个人 AI 伙伴。
