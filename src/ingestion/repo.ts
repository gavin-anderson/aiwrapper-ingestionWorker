// src/ingestion/repo.ts
import type { PoolClient } from "pg";
import type { ConversationRow, InboundMessageRow, InsertOutboundParams, ReplyJobRow } from "./types.js";

export async function claimReplyJob(client: PoolClient, args: {
    staleLockSeconds: number;
    workerId: string;
}): Promise<ReplyJobRow | null> {
    const query = `
    WITH candidate AS (
      SELECT id
      FROM reply_jobs
      WHERE
        (
          status IN ('queued','failed')
          AND run_after <= now()
        )
        OR
        (
          status = 'processing'
          AND locked_at IS NOT NULL
          AND locked_at < now() - ($1::int * interval '1 second')
        )
      ORDER BY run_after ASC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE reply_jobs j
    SET
      status = 'processing',
      locked_at = now(),
      locked_by = $2,
      updated_at = now()
    FROM candidate
    WHERE j.id = candidate.id
    RETURNING
      j.id, j.conversation_id, j.inbound_message_id, j.status,
      j.attempts, j.max_attempts, j.run_after, j.locked_at, j.locked_by, j.last_error
  `;
    const res = await client.query<ReplyJobRow>(query, [args.staleLockSeconds, args.workerId]);
    return res.rows[0] ?? null;
}

export async function loadInboundMessage(client: PoolClient, inboundId: string): Promise<InboundMessageRow> {
    const res = await client.query<InboundMessageRow>(
        `
    SELECT id, conversation_id, body, from_address, to_address, provider, provider_message_sid
    FROM inbound_messages
    WHERE id = $1
    `,
        [inboundId]
    );
    if (!res.rows[0]) throw new Error(`Inbound message not found: ${inboundId}`);
    return res.rows[0];
}

export async function loadConversation(client: PoolClient, conversationId: string): Promise<ConversationRow> {
    const res = await client.query<ConversationRow>(
        `
    SELECT id, channel, user_number
    FROM conversations
    WHERE id = $1
    `,
        [conversationId]
    );
    if (!res.rows[0]) throw new Error(`Conversation not found: ${conversationId}`);
    return res.rows[0];
}

export async function insertOutboundMessage(
    client: PoolClient,
    params: InsertOutboundParams
): Promise<string | null> {
    const res = await client.query<{ id: string }>(
        `
    INSERT INTO outbound_messages (
      conversation_id, inbound_message_id, reply_job_id,
      provider, to_address, from_address, body,
      status
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
    ON CONFLICT (inbound_message_id) DO NOTHING
    RETURNING id
    `,
        [
            params.conversationId,
            params.inboundMessageId,
            params.replyJobId,
            params.provider,
            params.toAddress,
            params.fromAddress,
            params.body,
        ]
    );
    return res.rows[0]?.id ?? null;
}

export async function markReplyJobSucceeded(client: PoolClient, jobId: string) {
    await client.query(
        `
    UPDATE reply_jobs
    SET
      status = 'succeeded',
      locked_at = NULL,
      locked_by = NULL,
      last_error = NULL,
      updated_at = now()
    WHERE id = $1
    `,
        [jobId]
    );
}

export async function markReplyJobFailedOrDeadletter(client: PoolClient, args: {
    job: ReplyJobRow;
    attemptsAfter: number;
    isDead: boolean;
    delaySeconds: number;
    lastError: string;
}) {
    await client.query(
        `
    UPDATE reply_jobs
    SET
      attempts = $2,
      status = CASE WHEN $3 THEN 'deadletter' ELSE 'failed' END,
      run_after = CASE
        WHEN $3 THEN run_after
        ELSE now() + make_interval(secs => $4)
      END,
      last_error = $5,
      locked_at = NULL,
      locked_by = NULL,
      updated_at = now()
    WHERE id = $1
    `,
        [args.job.id, args.attemptsAfter, args.isDead, args.delaySeconds, args.lastError]
    );
}
