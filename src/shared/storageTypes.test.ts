import { describe, expect, it } from 'vitest'
import type { StorageAudit, StorageOverview } from './storageTypes'

describe('storage IPC DTOs', () => {
  it('keeps unknown spill classifications explicit and structured-cloneable', () => {
    const overview: StorageOverview = {
      collectedAt: new Date(0).toISOString(), status: 'partial', totalBytes: null,
      database: { dbBytes: 12, walBytes: 0, shmBytes: 0, complete: true },
      spill: { files: 2, observedBytes: 50, totalBytes: 50, classification: 'unknown', sourceOfTruthBytes: null,
        degradableBytes: null, orphanBytes: null, complete: false, errorCodes: ['SPILL_REFERENCE_INDEX_UNAVAILABLE'] },
      spillDegraded: { files: 0, observedBytes: 0, totalBytes: 0, complete: true, errorCodes: [] },
      pendingGc: { files: 0, bytes: 0, complete: true }, tables: { messages: { rows: 0, textBytes: 0 } }
    }
    const audit: StorageAudit = { collectedAt: new Date(0).toISOString(), status: 'complete', errorCodes: [],
      canonicalCoverage: null, canonicalSessionCoverage: null, canonicalRequiredData: { eventRows: 0, eventPayloadBytes: 0, streamRows: 0, streamTableBytes: null },
      messageBodyCoverage: null, strictSpillReferences: { complete: true, descriptors: 0, uniqueLocators: 0, errorCodes: [] } }
    expect(structuredClone({ overview, audit })).toEqual({ overview, audit })
    expect(overview.spill.sourceOfTruthBytes).toBeNull()
    expect(JSON.stringify({ overview, audit })).not.toMatch(/private body|sha256|DatabaseSync|connection/i)
  })
})
