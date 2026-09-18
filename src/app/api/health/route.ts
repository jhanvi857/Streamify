import { NextResponse } from "next/server";
import { Pool } from "pg";

export async function GET() {
  const connectionString =
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/streamify?sslmode=disable";

  const isNeon =
    connectionString.includes("neon.tech") ||
    connectionString.includes("sslmode=require");

  const pool = new Pool({
    connectionString,
    ssl: isNeon ? { rejectUnauthorized: true } : undefined,
  });

  try {
    const client = await pool.connect();
    try {
      const dbRes = await client.query(
        "SELECT current_database() as db, version() as ver, NOW() as current_time"
      );
      const tablesRes = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
      );

      const dbName = dbRes.rows[0]?.db;
      const dbVersion = dbRes.rows[0]?.ver || "";
      const isNeonCloud =
        isNeon || dbVersion.toLowerCase().includes("neon");

      const tables = tablesRes.rows.map((r) => r.table_name);

      return NextResponse.json({
        status: "ok",
        database: "connected",
        provider: isNeonCloud ? "Neon PostgreSQL (Cloud)" : "PostgreSQL (Local)",
        current_database: dbName,
        server_time: dbRes.rows[0]?.current_time,
        tables_count: tables.length,
        tables,
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    return NextResponse.json(
      {
        status: "error",
        database: "disconnected",
        error: err.message,
        hint: "Check your DATABASE_URL in .env",
      },
      { status: 500 }
    );
  } finally {
    await pool.end();
  }
}
