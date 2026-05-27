import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

const authDatabaseSchema = process.env["AUTH_DATABASE_SCHEMA"] ?? "auth";
const authDatabaseUrl =
  process.env["AUTH_DATABASE_URL"] ??
  process.env["NEON_DATABASE_URL"] ??
  process.env["DATABASE_URL"];

if (!authDatabaseUrl && !process.argv.includes("generate")) {
  throw new Error("AUTH_DATABASE_URL, NEON_DATABASE_URL, or DATABASE_URL is required for auth database commands.");
}

function withDatabaseSchema(url: string, schema: string) {
  const parsed = new URL(url);
  if (!parsed.searchParams.has("schema")) {
    parsed.searchParams.set("schema", schema);
  }
  return parsed.toString();
}

export default defineConfig({
  schema: "prisma-auth/schema.prisma",
  datasource: {
    url: withDatabaseSchema(
      authDatabaseUrl ?? "postgresql://placeholder:placeholder@localhost:5432/placeholder",
      authDatabaseSchema
    ),
  },
});
