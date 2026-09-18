import { betterAuth } from "better-auth";
import { Pool } from "pg";

const dbUrl =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/streamify?sslmode=disable";

const isCloudDB =
  dbUrl.includes("neon.tech") || dbUrl.includes("sslmode=require");

export const auth = betterAuth({
  database: new Pool({
    connectionString: dbUrl,
    ssl: isCloudDB ? { rejectUnauthorized: true } : undefined,
  }),
  secret:
    process.env.BETTER_AUTH_SECRET ||
    "streamify-dev-secret-key-32-characters-long",
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  emailAndPassword: {
    enabled: true,
  },
});
