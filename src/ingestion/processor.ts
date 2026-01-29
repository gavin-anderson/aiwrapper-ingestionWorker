// src/ingestion/processor.ts
import { pool } from "../db/pool.js";
import type { ReplyJobRow } from "./types.js";
import { callModel } from "./model.js";
import { insertOutboundMessage, loadConversation, loadInboundMessage, markReplyJobSucceeded } from "./repo.js";
import { CONFIG } from "./config.js";

export async function processReplyJob(job: ReplyJobRow): Promise<{
    inboundProviderSid: string;
    insertedOutboundId: string | null;
}> {
    // Load inbound + convo (no open tx)
    const client1 = await pool.connect();
    try {
        const inbound = await loadInboundMessage(client1, job.inbound_message_id);
        // convo is not used yet, but loading it can be useful for future routing/config.
        await loadConversation(client1, job.conversation_id);

        const replyText = await callModel({
            userText: inbound.body,
            conversationId: job.conversation_id,
            inboundProviderSid: inbound.provider_message_sid,
            timeoutMs: CONFIG.MODEL_TIMEOUT_MS,
        });

        // Write outbound + mark succeeded atomically
        const client2 = await pool.connect();
        try {
            await client2.query("BEGIN");

            const insertedOutboundId = await insertOutboundMessage(client2, {
                conversationId: job.conversation_id,
                inboundMessageId: inbound.id,
                replyJobId: job.id,
                provider: inbound.provider,
                toAddress: inbound.from_address,  // send back to user
                fromAddress: inbound.to_address,  // your Twilio number
                body: replyText,
            });

            await markReplyJobSucceeded(client2, job.id);
            await client2.query("COMMIT");

            return { inboundProviderSid: inbound.provider_message_sid, insertedOutboundId };
        } catch (e) {
            await client2.query("ROLLBACK");
            throw e;
        } finally {
            client2.release();
        }
    } finally {
        client1.release();
    }
}
