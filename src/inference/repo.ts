// src/inference/repo.ts
import type { PoolClient } from "pg";
import type { ConversationRow, InboundMessageRow, InsertOutboundParams, InferenceJob, OutboundMessageRow, TimelineRow } from "./types.js";

export async function claimJobs(client: PoolClient, args: {
    staleLockSeconds: number;
    workerId: string;
}): Promise<InferenceJob[]> {
    // Step 1: Claim the first eligible inbound message
    const firstQuery = `
    WITH candidate AS (
      SELECT id
      FROM inbound_messages
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
      ORDER BY run_after ASC, received_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE inbound_messages j
    SET
      status = 'processing',
      locked_at = now(),
      locked_by = $2
    FROM candidate
    WHERE j.id = candidate.id
    RETURNING
      j.id, j.conversation_id, j.status,
      j.attempts, j.max_attempts, j.run_after, j.locked_at, j.locked_by, j.last_error
  `;
    const firstRes = await client.query<InferenceJob>(firstQuery, [args.staleLockSeconds, args.workerId]);
    const firstJob = firstRes.rows[0];
    if (!firstJob) return [];

    // Step 2: Claim all other eligible inbound messages for the same conversation
    const batchQuery = `
    WITH candidates AS (
      SELECT id
      FROM inbound_messages
      WHERE
        conversation_id = $3
        AND id != $4
        AND (
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
        )
      FOR UPDATE SKIP LOCKED
    )
    UPDATE inbound_messages j
    SET
      status = 'processing',
      locked_at = now(),
      locked_by = $2
    FROM candidates
    WHERE j.id = candidates.id
    RETURNING
      j.id, j.conversation_id, j.status,
      j.attempts, j.max_attempts, j.run_after, j.locked_at, j.locked_by, j.last_error
  `;
    const batchRes = await client.query<InferenceJob>(batchQuery, [
        args.staleLockSeconds,
        args.workerId,
        firstJob.conversation_id,
        firstJob.id,
    ]);

    return [firstJob, ...batchRes.rows];
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
      conversation_id, inbound_message_id,
      provider, to_address, from_address, body,
      status, provider_inbound_sid, sequence_number
    )
    VALUES ($1,$2,$3,$4,$5,$6,'pending', $7, $8)
    ON CONFLICT (inbound_message_id, sequence_number) DO NOTHING
    RETURNING id
    `,
        [
            params.conversationId,
            params.inboundMessageId,
            params.provider,
            params.toAddress,
            params.fromAddress,
            params.body,
            params.provider_inbound_sid,
            params.sequenceNumber
        ]
    );
    return res.rows[0]?.id ?? null;
}

export async function markJobsSucceeded(client: PoolClient, jobIds: string[]) {
    await client.query(
        `
    UPDATE inbound_messages
    SET
      status = 'succeeded',
      locked_at = NULL,
      locked_by = NULL,
      last_error = NULL,
      inferenced_at = now()
    WHERE id = ANY($1)
    `,
        [jobIds]
    );
}

export async function markJobsFailed(client: PoolClient, args: {
    jobs: InferenceJob[];
    isDead: boolean;
    delaySeconds: number;
    lastError: string;
}) {
    for (const job of args.jobs) {
        const attemptsAfter = job.attempts + 1;
        await client.query(
            `
      UPDATE inbound_messages
      SET
        attempts = $2,
        status = CASE WHEN $3 THEN 'deadletter' ELSE 'failed' END,
        run_after = CASE
          WHEN $3 THEN run_after
          ELSE now() + make_interval(secs => $4)
        END,
        last_error = $5,
        locked_at = NULL,
        locked_by = NULL
      WHERE id = $1
      `,
            [job.id, attemptsAfter, args.isDead, args.delaySeconds, args.lastError]
        );
    }
}


function renderTranscript(rows: TimelineRow[]): string {
    return rows
        .map((r) => {
            const who = r.direction === "inbound" ? "USER" : "JAY";
            return `${who}: ${r.body}`;
        })
        .join("\n");
}


export async function loadTranscriptForConversation(
    client: PoolClient,
    conversationId: string
): Promise<string> {
    // 1) convo metadata
    const convoRes = await client.query<ConversationRow>(
        `
      SELECT id, channel, user_number
      FROM conversations
      WHERE id = $1
    `,
        [conversationId]
    );
    const convo = convoRes.rows[0];
    if (!convo) throw new Error(`Conversation not found: ${conversationId}`);

    // 2) inbound from the user
    const inboundRes = await client.query<InboundMessageRow & { received_at: string }>(
        `
      SELECT id, conversation_id, body, from_address, to_address, provider, received_at
      FROM inbound_messages
      WHERE conversation_id = $1
        AND from_address = $2
      ORDER BY received_at ASC
    `,
        [conversationId, convo.user_number]
    );

    // 3) outbound to the user
    const outboundRes = await client.query<OutboundMessageRow>(
        `
      SELECT id, conversation_id, body, from_address, to_address, provider, created_at
      FROM outbound_messages
      WHERE conversation_id = $1
        AND to_address = $2
        AND status IN ('sent','sending') -- optional: keep only actually sent-ish messages
      ORDER BY created_at ASC
    `,
        [conversationId, convo.user_number]
    );

    // 4) merge into one timeline
    const timeline: TimelineRow[] = [
        ...inboundRes.rows.map((m) => ({
            direction: "inbound" as const,
            body: m.body,
            from_address: m.from_address,
            to_address: m.to_address,
            provider: m.provider,
            ts: (m as any).received_at, // typed above
        })),
        ...outboundRes.rows.map((m) => ({
            direction: "outbound" as const,
            body: m.body,
            from_address: m.from_address,
            to_address: m.to_address,
            provider: m.provider,
            ts: m.created_at,
        })),
    ].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

    return renderTranscript(timeline);
}
