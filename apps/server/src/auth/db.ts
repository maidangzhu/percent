import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "../generated/auth-prisma/client.js";

const authDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(authDir, "../../.env") });
dotenv.config({ path: path.resolve(authDir, "../../../../.env") });

const authDatabaseSchema = process.env["AUTH_DATABASE_SCHEMA"] ?? "auth";
const connectionString =
  process.env["AUTH_DATABASE_URL"] ??
  process.env["NEON_DATABASE_URL"] ??
  process.env["DATABASE_URL"];

if (!connectionString) {
  throw new Error("AUTH_DATABASE_URL, NEON_DATABASE_URL, or DATABASE_URL is required for Better Auth.");
}

function withDatabaseSchema(url: string, schema: string) {
  const parsed = new URL(url);
  if (!parsed.searchParams.has("schema")) {
    parsed.searchParams.set("schema", schema);
  }
  return parsed.toString();
}

const adapter = new PrismaNeon(
  { connectionString: withDatabaseSchema(connectionString, authDatabaseSchema) },
  { schema: authDatabaseSchema }
);

export const authPrisma = new PrismaClient({ adapter });
