// src/inference/processor.ts
import { pool } from "../db/pool.js";
import type { InferenceJob } from "./types.js";
import { callModel } from "./model.js";
import { NO_REPLY_SENTINEL } from "./prompt.js";
import { insertOutboundMessage, loadConversation, loadInboundMessage, markJobsSucceeded, loadTranscriptForConversation } from "./repo.js";
import { CONFIG } from "./config.js";

export async function runInference(jobs: InferenceJob[]): Promise<{
    inboundProviderSid: string;
    insertedOutboundIds: string[];
    noReply: boolean;
}> {
    // Use the last job (most recent) for outbound linking
    const lastJob = jobs[jobs.length - 1];

    // --- READ PHASE (short) ---
    const client1 = await pool.connect();
    let inbound: Awaited<ReturnType<typeof loadInboundMessage>>;
    let conversationContext: string;

    try {
        inbound = await loadInboundMessage(client1, lastJob.id);
        conversationContext = await loadTranscriptForConversation(client1, lastJob.conversation_id);
        await loadConversation(client1, lastJob.conversation_id);
    } finally {
        client1.release();
    }

    // --- MODEL PHASE ---
    const replyText = await callModel({
        conversationId: lastJob.conversation_id,
        inboundProviderSid: inbound.provider_message_sid,
        timeoutMs: CONFIG.MODEL_TIMEOUT_MS,
        conversationContext,
    });

    // --- WRITE PHASE (transaction) ---
    const noReply = replyText.trim() === NO_REPLY_SENTINEL;
    const jobIds = jobs.map(j => j.id);

    const client2 = await pool.connect();
    try {
        await client2.query("BEGIN");

        const insertedOutboundIds: string[] = [];
        if (!noReply) {
            // Split on tab or double-newline
            const segments = replyText
                .split(/\t|\n\n/)
                .map(s => s.trim())
                .filter(s => s.length > 0);

            for (let i = 0; i < segments.length; i++) {
                const id = await insertOutboundMessage(client2, {
                    conversationId: lastJob.conversation_id,
                    inboundMessageId: inbound.id,
                    provider: inbound.provider,
                    toAddress: inbound.from_address,
                    fromAddress: inbound.to_address,
                    body: segments[i],
                    provider_inbound_sid: inbound.provider_message_sid,
                    sequenceNumber: i,
                });
                if (id) insertedOutboundIds.push(id);
            }
        }

        await markJobsSucceeded(client2, jobIds);
        await client2.query("COMMIT");

        return { inboundProviderSid: inbound.provider_message_sid, insertedOutboundIds, noReply };
    } catch (e) {
        await client2.query("ROLLBACK");
        throw e;
    } finally {
        client2.release();
    }
}
