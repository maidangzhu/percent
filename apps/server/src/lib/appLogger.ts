type LogLevel = "info" | "warn" | "error";
type LogFields = Record<string, unknown>;

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  return value;
}

function writeLog(level: LogLevel, event: string, fields: LogFields = {}) {
  const payload: LogFields = {
    ts: new Date().toISOString(),
    level,
    event,
  };

  for (const [key, value] of Object.entries(fields)) {
    payload[key] = normalize(value);
  }

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function logInfo(event: string, fields?: LogFields) {
  writeLog("info", event, fields);
}

export function logWarn(event: string, fields?: LogFields) {
  writeLog("warn", event, fields);
}

export function logError(event: string, fields?: LogFields) {
  writeLog("error", event, fields);
}

export function elapsedMs(startedAt: number) {
  return Date.now() - startedAt;
}
