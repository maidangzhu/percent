import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { authPrisma } from "./db.js";

const fallbackSecret = "percent-tracker-local-dev-secret-change-me";

export const auth = betterAuth({
  basePath: "/api/auth",
  baseURL: process.env["BETTER_AUTH_URL"] ?? "http://localhost:3000",
  secret: process.env["BETTER_AUTH_SECRET"] ?? fallbackSecret,
  trustedOrigins: [
    "http://localhost:1420",
    "http://127.0.0.1:1420",
    "tauri://localhost",
    "http://tauri.localhost",
  ],
  database: prismaAdapter(authPrisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  advanced: {
    useSecureCookies: false,
  },
});
