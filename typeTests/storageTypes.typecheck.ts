import type { StorageAudit, StorageOverview } from '../src/shared/storageTypes'

const unknownOverview: StorageOverview = {
  collectedAt: new Date(0).toISOString(), status: 'partial', totalBytes: null,
  database: { dbBytes: 1, walBytes: 0, shmBytes: 0, complete: true },
  spill: { files: 1, observedBytes: 10, totalBytes: 10, classification: 'unknown', sourceOfTruthBytes: null,
    degradableBytes: null, orphanBytes: null, complete: false, errorCodes: ['INDEX_UNAVAILABLE'] },
  spillDegraded: { files: 0, observedBytes: 0, totalBytes: 0, complete: true, errorCodes: [] },
  pendingGc: { files: 0, bytes: 0, complete: true }, tables: { messages: { rows: 0, textBytes: 0 } }
}
const audit: StorageAudit = { collectedAt: new Date(0).toISOString(), status: 'pending', errorCodes: [],
  canonicalCoverage: null, canonicalSessionCoverage: null, canonicalRequiredData: null, messageBodyCoverage: null,
  strictSpillReferences: null }

void [unknownOverview, audit]
