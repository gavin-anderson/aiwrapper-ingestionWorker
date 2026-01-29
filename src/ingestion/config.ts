// src/ingestion/config.ts
import crypto from "crypto";

export function requiredEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

export const CONFIG = {
    WORKER_ID: process.env.WORKER_ID ?? `ingestion-worker-${crypto.randomUUID()}`,
    POLL_MS: parseInt(process.env.REPLY_WORKER_POLL_MS ?? "500", 10),
    STALE_LOCK_SECONDS: parseInt(process.env.REPLY_JOB_STALE_LOCK_SECONDS ?? "120", 10),
    MODEL_TIMEOUT_MS: parseInt(process.env.MODEL_TIMEOUT_MS ?? "35000", 10),
};
