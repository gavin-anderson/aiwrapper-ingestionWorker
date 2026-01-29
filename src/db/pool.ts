// src/db/pool.ts
import { Pool } from "pg";
import { requiredEnv } from "../ingestion/config.js";

export const pool = new Pool({
    connectionString: requiredEnv("DATABASE_URL"),
    // If you needed this for Supabase pooler locally, uncomment:
    // ssl: { rejectUnauthorized: false },
});
