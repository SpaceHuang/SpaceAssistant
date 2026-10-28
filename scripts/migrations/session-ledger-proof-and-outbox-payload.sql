-- Path A: retire the seven proof columns and the three outbox payload/digest columns.
-- Rollback: restore the closed pre-migration database snapshot; canonical payloads can be regenerated,
-- but legacy-only payload data cannot be reconstructed after this migration.
BEGIN IMMEDIATE;
ALTER TABLE session_ledger_projection_state DROP COLUMN proof_file_identity;
ALTER TABLE session_ledger_projection_state DROP COLUMN proof_file_bytes;
ALTER TABLE session_ledger_projection_state DROP COLUMN proof_tail_frame;
ALTER TABLE session_ledger_projection_state DROP COLUMN proof_index_seq;
ALTER TABLE session_ledger_projection_state DROP COLUMN proof_index_event_count;
ALTER TABLE session_ledger_projection_state DROP COLUMN proof_index_bytes;
ALTER TABLE session_ledger_projection_state DROP COLUMN proof_index_last_at;
ALTER TABLE session_ledger_projection_outbox DROP COLUMN expected_events_json;
ALTER TABLE session_ledger_projection_outbox DROP COLUMN expected_event_ids_json;
ALTER TABLE session_ledger_projection_outbox DROP COLUMN payload_sha256;
COMMIT;
