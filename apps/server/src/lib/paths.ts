import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PERSISTENT_DIR =
  process.env.PERCENT_HOME ?? path.join(os.homedir(), ".percent-tracker");

export const LOCAL_DATABASE_PATH =
  process.env.PERCENT_DATABASE_PATH ?? path.join(PERSISTENT_DIR, "percent.db");

export function ensurePersistentDir() {
  fs.mkdirSync(PERSISTENT_DIR, { recursive: true });
}
