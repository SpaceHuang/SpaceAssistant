-- Path B (default): retire the seven proof columns and preserve all outbox columns.
-- Rollback: restore the closed pre-migration database snapshot; proof data cannot be reconstructed.
BEGIN IMMEDIATE;
ALTER TABLE session_ledger_projection_state DROP COLUMN proof_file_identity;
ALTER TABLE session_ledger_projection_state DROP COLUMN proof_file_bytes;
ALTER TABLE session_ledger_projection_state DROP COLUMN proof_tail_frame;
ALTER TABLE session_ledger_projection_state DROP COLUMN proof_index_seq;
ALTER TABLE session_ledger_projection_state DROP COLUMN proof_index_event_count;
ALTER TABLE session_ledger_projection_state DROP COLUMN proof_index_bytes;
ALTER TABLE session_ledger_projection_state DROP COLUMN proof_index_last_at;
COMMIT;
