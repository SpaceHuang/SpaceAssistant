import { createHash } from 'node:crypto'
import {
  DB_SCHEMA_VERSION,
  MESSAGE_CONTENT_STORAGE_STATES,
  SESSION_CONTENT_CLEANUP_STATES,
} from '../database/schema'
import {
  AGENT_HISTORY_SCHEMA_VERSION,
  HISTORY_EVENT_KINDS,
  HISTORY_PAYLOAD_VALIDATOR_REVISION,
} from '../../packages/agent-sdk/src/history'
import { CANONICAL_SESSION_CACHE_VERSION } from '../runtime/sessionTranscriptCacheFormat'
import {
  SESSION_TRANSCRIPT_SPILL_MARKER,
  SOURCE_TRUTH_SPILL_MARKER,
  SPILL_DESCRIPTOR_VERSION,
} from './spillProtocol'

/**
 * Bump the validator revision when a persisted event payload/transition contract changes.
 * All other values are imported from the implementation constants used by their writers/readers.
 */
export const SESSION_STORAGE_DATA_CONTRACT = Object.freeze({
  contract: 'spaceassistant.session-storage',
  revision: 1,
  databaseSchemaVersion: DB_SCHEMA_VERSION,
  history: {
    schemaVersion: AGENT_HISTORY_SCHEMA_VERSION,
    payloadValidatorRevision: HISTORY_PAYLOAD_VALIDATOR_REVISION,
    eventKinds: HISTORY_EVENT_KINDS,
    payloadEncoding: 'canonical-json',
  },
  sourceSpill: {
    descriptorVersion: SPILL_DESCRIPTOR_VERSION,
    markerKeys: [SOURCE_TRUTH_SPILL_MARKER, SESSION_TRANSCRIPT_SPILL_MARKER],
    contentEncoding: 'utf-8',
    checksum: 'sha256',
  },
  transcriptCache: {
    codecVersion: CANONICAL_SESSION_CACHE_VERSION,
    valueChecksum: 'sha256',
  },
  messageContentStorageStates: MESSAGE_CONTENT_STORAGE_STATES,
  cleanupLedgerStates: SESSION_CONTENT_CLEANUP_STATES,
})

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortObjectKeys(child)]))
}

export const SESSION_STORAGE_DATA_CONTRACT_CANONICAL_JSON = JSON.stringify(sortObjectKeys(SESSION_STORAGE_DATA_CONTRACT))
export const SESSION_STORAGE_DATA_CONTRACT_SHA256 = createHash('sha256')
  .update(SESSION_STORAGE_DATA_CONTRACT_CANONICAL_JSON, 'utf8')
  .digest('hex')
