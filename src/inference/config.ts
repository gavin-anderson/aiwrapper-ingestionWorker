// src/inference/config.ts
import crypto from "crypto";

export function requiredEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

export const CONFIG = {
    WORKER_ID: `inference-worker-${crypto.randomUUID()}`,
    POLL_MS: parseInt(process.env.INFERENCE_POLL_MS ?? "1000", 10),
    STALE_LOCK_SECONDS: 120,
    MODEL_TIMEOUT_MS: parseInt(process.env.MODEL_TIMEOUT_MS ?? "35000", 10),
};
