// src/inference/types.ts
export type JobStatus = "queued" | "processing" | "succeeded" | "failed" | "deadletter";

export type InferenceJob = {
    id: string;
    conversation_id: string;
    status: JobStatus;
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

export type OutboundMessageRow = {
    id: string;
    conversation_id: string;
    body: string;
    from_address: string;
    to_address: string;
    provider: string;
    created_at: string; // or sent_at if you have it
};

export type TimelineRow = {
    direction: "inbound" | "outbound";
    body: string;
    from_address: string;
    to_address: string;
    provider: string;
    ts: string; // ISO string from DB
};

export type ConversationRow = {
    id: string;
    channel: string;
    user_number: string;
};

export type InsertOutboundParams = {
    conversationId: string;
    inboundMessageId: string;
    provider: string;
    toAddress: string;
    fromAddress: string;
    body: string;
    provider_inbound_sid: string | null;
    sequenceNumber: number;
};
