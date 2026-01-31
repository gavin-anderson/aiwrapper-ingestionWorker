// src/ingestion/types.ts
export type ReplyJobStatus = "queued" | "processing" | "succeeded" | "failed" | "deadletter";

export type ReplyJobRow = {
    id: string;
    conversation_id: string;
    inbound_message_id: string;
    status: ReplyJobStatus;
    attempts: number;
    max_attempts: number;
    run_after: string;
    locked_at: string | null;
    locked_by: string | null;
    last_error: string | null;
};

export type InboundMessageRow = {
    id: string;
    conversation_id: string;
    body: string;
    from_address: string;
    to_address: string;
    provider: string;
    provider_message_sid: string;
};

export type ConversationRow = {
    id: string;
    channel: string;
    user_number: string;
};

export type InsertOutboundParams = {
    conversationId: string;
    inboundMessageId: string;
    replyJobId: string;
    provider: string;
    toAddress: string;
    fromAddress: string;
    body: string;
    provider_inbound_sid: string | null;
};
