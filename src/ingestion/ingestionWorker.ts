// src/ingestion/ingestionWorker.ts
import "dotenv/config";
import { pool } from "../db/pool.js";
import { CONFIG } from "./config.js";
import { computeReplyBackoffSeconds, sleep, truncate } from "./utils.js";
import { claimReplyJob, markReplyJobFailedOrDeadletter } from "./repo.js";
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
            const job = await claimReplyJob(client, {
                staleLockSeconds: CONFIG.STALE_LOCK_SECONDS,
                workerId: CONFIG.WORKER_ID,
            });
            await client.query("COMMIT");

            if (!job) {
                await sleep(CONFIG.POLL_MS);
                continue;
            }

            console.log(
                `[${CONFIG.WORKER_ID}] Claimed job=${job.id} convo=${job.conversation_id} inbound=${job.inbound_message_id} attempts=${job.attempts}/${job.max_attempts}`
            );

            try {
                const result = await processReplyJob(job);

                if (result.insertedOutboundIds.length > 0) {
                    console.log(
                        `[${CONFIG.WORKER_ID}] Job ${job.id} succeeded; ${result.insertedOutboundIds.length} outbound message(s) queued [${result.insertedOutboundIds.join(", ")}] (inbound ${result.inboundProviderSid})`
                    );
                } else if (result.noReply) {
                    console.log(
                        `[${CONFIG.WORKER_ID}] Job ${job.id} succeeded; no reply (Slash chose [NO_REPLY]) (inbound ${result.inboundProviderSid})`
                    );
                } else {
                    console.log(
                        `[${CONFIG.WORKER_ID}] Job ${job.id} succeeded; outbound already existed (idempotent) (inbound ${result.inboundProviderSid})`
                    );
                }
            } catch (err: any) {
                const msg = err?.stack || err?.message || String(err);
                console.warn(`[${CONFIG.WORKER_ID}] Job ${job.id} failed: ${truncate(msg, 800)}`);

                const attemptsAfter = job.attempts + 1;
                const isDead = attemptsAfter >= job.max_attempts;
                const delaySeconds = isDead ? 0 : computeReplyBackoffSeconds(attemptsAfter);

                const clientFail = await pool.connect();
                try {
                    await clientFail.query("BEGIN");
                    await markReplyJobFailedOrDeadletter(clientFail, {
                        job,
                        attemptsAfter,
                        isDead,
                        delaySeconds,
                        lastError: truncate(msg, 2000),
                    });
                    await clientFail.query("COMMIT");
                } catch (e: any) {
                    await clientFail.query("ROLLBACK");
                    console.error(
                        `[${CONFIG.WORKER_ID}] Failed to mark job ${job.id} failed/deadletter:`,
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
