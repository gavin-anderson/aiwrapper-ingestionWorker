// src/db/pool.ts
import { Pool } from "pg";
import { requiredEnv } from "../ingestion/config.js";

export const pool = new Pool({
    connectionString: requiredEnv("DATABASE_URL"),
    max: parseInt(process.env.PG_POOL_MAX ?? "10", 10),
    idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT_MS ?? "30000", 10),
    connectionTimeoutMillis: parseInt(process.env.PG_CONN_TIMEOUT_MS ?? "5000", 10),
    // ssl: { rejectUnauthorized: false },
})