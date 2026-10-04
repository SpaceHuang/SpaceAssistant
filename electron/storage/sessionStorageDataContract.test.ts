import { describe, expect, it } from 'vitest'
import {
  CREATE_TABLES_SQL,
  DB_SCHEMA_VERSION,
  MESSAGE_CONTENT_STORAGE_STATES,
  MIGRATION_V44_SESSION_CONTENT_WRITE_STOPPED_STATE_SQL,
  SESSION_CONTENT_CLEANUP_STATES,
} from '../database/schema'
import { AGENT_HISTORY_SCHEMA_VERSION, HISTORY_EVENT_KINDS, HISTORY_PAYLOAD_VALIDATOR_REVISION } from '../../packages/agent-sdk/src/history'
import { CANONICAL_SESSION_CACHE_VERSION } from '../runtime/sessionTranscriptCacheFormat'
import {
  SESSION_STORAGE_DATA_CONTRACT,
  SESSION_STORAGE_DATA_CONTRACT_CANONICAL_JSON,
  SESSION_STORAGE_DATA_CONTRACT_SHA256,
} from './sessionStorageDataContract'
import { SESSION_TRANSCRIPT_SPILL_MARKER, SOURCE_TRUTH_SPILL_MARKER, SPILL_DESCRIPTOR_VERSION, SPILL_MARKER_KEYS } from './spillProtocol'

describe('session storage compatibility contract', () => {
  it('derives its format values from the current schema, History, cache, and spill definitions', () => {
    expect(SESSION_STORAGE_DATA_CONTRACT).toMatchObject({
      databaseSchemaVersion: DB_SCHEMA_VERSION,
      history: {
        schemaVersion: AGENT_HISTORY_SCHEMA_VERSION,
        payloadValidatorRevision: HISTORY_PAYLOAD_VALIDATOR_REVISION,
        eventKinds: HISTORY_EVENT_KINDS,
      },
      sourceSpill: {
        descriptorVersion: SPILL_DESCRIPTOR_VERSION,
        markerKeys: [SOURCE_TRUTH_SPILL_MARKER, SESSION_TRANSCRIPT_SPILL_MARKER],
      },
      transcriptCache: { codecVersion: CANONICAL_SESSION_CACHE_VERSION },
      messageContentStorageStates: MESSAGE_CONTENT_STORAGE_STATES,
      cleanupLedgerStates: SESSION_CONTENT_CLEANUP_STATES,
    })
    expect(SESSION_STORAGE_DATA_CONTRACT.history.eventKinds).toHaveLength(18)
  })

  it('produces canonical JSON and a SHA-256 digest suitable for the reviewed release record', () => {
    expect(SESSION_STORAGE_DATA_CONTRACT_CANONICAL_JSON).toContain('spaceassistant.session-storage')
    expect(SESSION_STORAGE_DATA_CONTRACT_SHA256).toBe('4d718a5e06fcf0cf38adff60b4b8dde2c27d56d33ddfd5723dde28df74da5830')
  })

  it('keeps the persisted-format constants and nested manifest immutable at runtime', () => {
    expect(Object.isFrozen(HISTORY_EVENT_KINDS)).toBe(true)
    expect(Object.isFrozen(MESSAGE_CONTENT_STORAGE_STATES)).toBe(true)
    expect(Object.isFrozen(SESSION_CONTENT_CLEANUP_STATES)).toBe(true)
    expect(Object.isFrozen(SPILL_MARKER_KEYS)).toBe(true)
    expect(Object.isFrozen(SESSION_STORAGE_DATA_CONTRACT)).toBe(true)
    expect(Object.isFrozen(SESSION_STORAGE_DATA_CONTRACT.history)).toBe(true)
    expect(Object.isFrozen(SESSION_STORAGE_DATA_CONTRACT.history.eventKinds)).toBe(true)
    expect(Object.isFrozen(SESSION_STORAGE_DATA_CONTRACT.sourceSpill.markerKeys)).toBe(true)
  })

  it('keeps body and cleanup state constraints in the SQLite DDL aligned with the hashed contract', () => {
    expect(CREATE_TABLES_SQL).toContain(`content_storage_state IN (${MESSAGE_CONTENT_STORAGE_STATES.map((state) => `'${state}'`).join(',')})`)
    expect(MIGRATION_V44_SESSION_CONTENT_WRITE_STOPPED_STATE_SQL)
      .toContain(`cleanup_state IN (${SESSION_CONTENT_CLEANUP_STATES.map((state) => `'${state}'`).join(',')})`)
  })
})
