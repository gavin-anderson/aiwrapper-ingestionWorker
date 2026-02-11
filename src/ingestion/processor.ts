// src/ingestion/processor.ts
import { pool } from "../db/pool.js";
import type { ReplyJobRow } from "./types.js";
import { callModel } from "./model.js";
import { NO_REPLY_SENTINEL } from "./prompt.js";
import { insertOutboundMessage, loadConversation, loadInboundMessage, markReplyJobSucceeded, loadTranscriptForConversation } from "./repo.js";
import { CONFIG } from "./config.js";

export async function processReplyJob(job: ReplyJobRow): Promise<{
    inboundProviderSid: string;
    insertedOutboundIds: string[];
    noReply: boolean;
}> {
    // --- READ PHASE (short) ---
    const client1 = await pool.connect();
    let inbound: Awaited<ReturnType<typeof loadInboundMessage>>;
    let conversationContext: string;

    try {
        inbound = await loadInboundMessage(client1, job.inbound_message_id);
        conversationContext = await loadTranscriptForConversation(client1, job.conversation_id);
        await loadConversation(client1, job.conversation_id);
    } finally {
        client1.release();
    }

    // --- MODEL PHASE ---
    const replyText = await callModel({
        conversationId: job.conversation_id,
        inboundProviderSid: inbound.provider_message_sid,
        timeoutMs: CONFIG.MODEL_TIMEOUT_MS,
        conversationContext,
    });

    // --- WRITE PHASE (transaction) ---
    const noReply = replyText.trim() === NO_REPLY_SENTINEL;

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
                    conversationId: job.conversation_id,
                    inboundMessageId: inbound.id,
                    replyJobId: job.id,
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

        await markReplyJobSucceeded(client2, job.id);
        await client2.query("COMMIT");

        return { inboundProviderSid: inbound.provider_message_sid, insertedOutboundIds, noReply };
    } catch (e) {
        await client2.query("ROLLBACK");
        throw e;
    } finally {
        client2.release();
    }
}
