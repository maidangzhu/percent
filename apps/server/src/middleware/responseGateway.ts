import type { Context, MiddlewareHandler } from "hono";
import { logError } from "../lib/appLogger.js";

function isWrapped(value: unknown) {
  return (
    value != null &&
    typeof value === "object" &&
    "code" in value &&
    "message" in value &&
    "data" in value
  );
}

function messageForStatus(status: number) {
  if (status >= 200 && status < 300) return "ok";
  if (status === 400) return "bad request";
  if (status === 404) return "not found";
  if (status === 502) return "bad gateway";
  return "error";
}

export function responseGateway(): MiddlewareHandler {
  return async (c, next) => {
    await next();

    if (c.req.path.startsWith("/api/")) return;

    const contentType = c.res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return;

    const status = c.res.status;
    const body = await c.res.clone().json().catch(() => null);
    if (isWrapped(body)) return;

    const isSuccess = status >= 200 && status < 300;
    const message =
      typeof body?.message === "string"
        ? body.message
        : typeof body?.error === "string"
          ? body.error
          : messageForStatus(status);
    const data = isSuccess ? (body?.data ?? body) : (body?.data ?? null);

    c.res = c.json(
      {
        code: isSuccess ? 0 : status,
        message,
        data,
      },
      status as Parameters<Context["json"]>[1]
    );
  };
}

export function gatewayErrorHandler(error: Error, c: Context) {
  logError("server.unhandled_error", {
    method: c.req.method,
    path: c.req.path,
    error,
  });

  return c.json({ code: 500, message: "internal server error", data: null }, 500);
}
