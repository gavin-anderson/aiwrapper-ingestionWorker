// src/ingestion/ingestionWorker.ts
import "dotenv/config";
import { pool } from "../db/pool.js";
import { CONFIG } from "./config.js";
import { computeReplyBackoffSeconds, sleep, truncate } from "./utils.js";
import { claimReplyJobs, markReplyJobsFailedOrDeadletter } from "./repo.js";
import { processReplyJob } from "./processor.js";

let stopping = false;

process.on("SIGINT", () => {
    console.log(`[${CONFIG.WORKER_ID}] SIGINT received, stopping...`);
    stopping = true;
});
process.on("SIGTERM", () => {
    console.log(`[${CONFIG.WORKER_ID}] SIGTERM received, stopping...`);
    stopping = true;
});

async function run() {
    console.log(
        `[${CONFIG.WORKER_ID}] ingestion-worker starting. poll=${CONFIG.POLL_MS}ms staleLock=${CONFIG.STALE_LOCK_SECONDS}s`
    );

    const r = await pool.query("select now() as now");
    console.log(`[${CONFIG.WORKER_ID}] DB OK at`, r.rows[0].now);

    while (!stopping) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const jobs = await claimReplyJobs(client, {
                staleLockSeconds: CONFIG.STALE_LOCK_SECONDS,
                workerId: CONFIG.WORKER_ID,
            });
            await client.query("COMMIT");

            if (jobs.length === 0) {
                await sleep(CONFIG.POLL_MS);
                continue;
            }

            const jobIds = jobs.map(j => j.id);
            const lastJob = jobs[jobs.length - 1];
            console.log(
                `[${CONFIG.WORKER_ID}] Claimed ${jobs.length} job(s) [${jobIds.join(", ")}] convo=${lastJob.conversation_id}`
            );

            try {
                const result = await processReplyJob(jobs);

                if (result.insertedOutboundIds.length > 0) {
                    console.log(
                        `[${CONFIG.WORKER_ID}] Batch [${jobIds.join(", ")}] succeeded; ${result.insertedOutboundIds.length} outbound message(s) queued [${result.insertedOutboundIds.join(", ")}] (inbound ${result.inboundProviderSid})`
                    );
                } else if (result.noReply) {
                    console.log(
                        `[${CONFIG.WORKER_ID}] Batch [${jobIds.join(", ")}] succeeded; no reply (Slash chose [NO_REPLY]) (inbound ${result.inboundProviderSid})`
                    );
                } else {
                    console.log(
                        `[${CONFIG.WORKER_ID}] Batch [${jobIds.join(", ")}] succeeded; outbound already existed (idempotent) (inbound ${result.inboundProviderSid})`
                    );
                }
            } catch (err: any) {
                const msg = err?.stack || err?.message || String(err);
                console.warn(`[${CONFIG.WORKER_ID}] Batch [${jobIds.join(", ")}] failed: ${truncate(msg, 800)}`);

                const maxAttempts = Math.max(...jobs.map(j => j.max_attempts));
                const maxAttemptsAfter = Math.max(...jobs.map(j => j.attempts + 1));
                const isDead = maxAttemptsAfter >= maxAttempts;
                const delaySeconds = isDead ? 0 : computeReplyBackoffSeconds(maxAttemptsAfter);

                const clientFail = await pool.connect();
                try {
                    await clientFail.query("BEGIN");
                    await markReplyJobsFailedOrDeadletter(clientFail, {
                        jobs,
                        isDead,
                        delaySeconds,
                        lastError: truncate(msg, 2000),
                    });
                    await clientFail.query("COMMIT");
                } catch (e: any) {
                    await clientFail.query("ROLLBACK");
                    console.error(
                        `[${CONFIG.WORKER_ID}] Failed to mark batch [${jobIds.join(", ")}] failed/deadletter:`,
                        e?.stack || e
                    );
                } finally {
                    clientFail.release();
                }
            }
        } catch (err: any) {
            try {
                await client.query("ROLLBACK");
            } catch { }
            console.error(`[${CONFIG.WORKER_ID}] Loop error:`, err?.stack || err);
            await sleep(Math.min(2000, CONFIG.POLL_MS));
        } finally {
            client.release();
        }
    }

    console.log(`[${CONFIG.WORKER_ID}] stopping; draining pool...`);
    await pool.end();
    console.log(`[${CONFIG.WORKER_ID}] exited cleanly.`);
}

run().catch((e) => {
    console.error(`[${CONFIG.WORKER_ID}] fatal error:`, e?.stack || e);
    process.exit(1);
});
