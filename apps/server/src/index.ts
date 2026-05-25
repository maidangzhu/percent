import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { logsRouter } from "./routes/logs.js";
import { peopleRouter } from "./routes/people.js";
import { analyzeRouter } from "./routes/analyze.js";
import { chatRouter } from "./routes/chat.js";
import { suggestRouter } from "./routes/suggest.js";
import { tasksRouter } from "./routes/tasks.js";
import { logInfo } from "./lib/appLogger.js";
import { gatewayErrorHandler, responseGateway } from "./middleware/responseGateway.js";

const app = new Hono();

app.use("*", logger());
app.use("*", cors({ origin: "*" }));
app.use("*", responseGateway());
app.onError(gatewayErrorHandler);

app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

app.route("/logs", logsRouter);
app.route("/people", peopleRouter);
app.route("/analyze", analyzeRouter);
app.route("/chat", chatRouter);
app.route("/suggest", suggestRouter);
app.route("/tasks", tasksRouter);

const PORT = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port: PORT }, () => {
  logInfo("server.started", { url: `http://localhost:${PORT}` });
});
