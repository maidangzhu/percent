import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { MastraServer } from "@mastra/hono";

import { logsRouter } from "./routes/logs.js";
import { peopleRouter } from "./routes/people.js";
import { analyzeRouter } from "./routes/analyze.js";
import { chatRouter } from "./routes/chat.js";
import { agentRouter } from "./routes/agent.js";
import { suggestRouter } from "./routes/suggest.js";
import { tasksRouter } from "./routes/tasks.js";
import { auth } from "./auth/index.js";
import { logInfo } from "./lib/appLogger.js";
import { gatewayErrorHandler, responseGateway } from "./middleware/responseGateway.js";
import { initializeLocalDatabase } from "./db/init.js";
import { mastra } from "./mastra.js";

const app = new Hono();
const allowedOrigins = new Set([
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "tauri://localhost",
  "http://tauri.localhost",
]);

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return null;
      if (allowedOrigins.has(origin)) return origin;
      if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return origin;
      return null;
    },
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  })
);
app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

const mastraServer = new MastraServer({
  app,
  mastra,
  prefix: "/api",
});
await mastraServer.init();

app.use("*", responseGateway());
app.onError(gatewayErrorHandler);

app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

app.route("/logs", logsRouter);
app.route("/people", peopleRouter);
app.route("/analyze", analyzeRouter);
app.route("/agent", agentRouter);
app.route("/chat", chatRouter);
app.route("/suggest", suggestRouter);
app.route("/tasks", tasksRouter);

const PORT = Number(process.env.PORT ?? 3000);

const db = await initializeLocalDatabase();

serve({ fetch: app.fetch, port: PORT }, () => {
  logInfo("server.started", { url: `http://localhost:${PORT}`, database_path: db.path });
});
