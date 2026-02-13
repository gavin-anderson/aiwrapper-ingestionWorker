// src/db/pool.ts
import { Pool } from "pg";
import { requiredEnv } from "../inference/config.js";

export const pool = new Pool({
    connectionString: requiredEnv("DATABASE_URL"),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // ssl: { rejectUnauthorized: false },
})