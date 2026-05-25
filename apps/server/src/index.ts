import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { logsRouter } from "./routes/logs.js";
import { peopleRouter } from "./routes/people.js";
import { analyzeRouter } from "./routes/analyze.js";
import { suggestRouter } from "./routes/suggest.js";

const app = new Hono();

app.use("*", logger());
app.use("*", cors({ origin: "*" }));

app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

app.route("/logs", logsRouter);
app.route("/people", peopleRouter);
app.route("/analyze", analyzeRouter);
app.route("/suggest", suggestRouter);

const PORT = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`server running on http://localhost:${PORT}`);
});
