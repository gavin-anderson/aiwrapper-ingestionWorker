-- Add sequence_number to support splitting a model response into multiple outbound messages.
-- The response-worker should ORDER BY sequence_number ASC when sending.

ALTER TABLE outbound_messages
  ADD COLUMN sequence_number INTEGER NOT NULL DEFAULT 0;

-- Drop the old unique constraint on inbound_message_id alone.
ALTER TABLE outbound_messages
  DROP CONSTRAINT outbound_messages_inbound_message_uniq;

-- Drop the old unique constraint on reply_job_id alone (multiple segments per job now).
ALTER TABLE outbound_messages
  DROP CONSTRAINT outbound_messages_reply_job_id_key;

-- New compound unique: one row per (inbound_message, sequence_number).
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_inbound_message_id_seq_key
  UNIQUE (inbound_message_id, sequence_number);
