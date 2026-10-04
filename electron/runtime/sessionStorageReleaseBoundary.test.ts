import { describe, expect, it } from 'vitest'
import { findForbiddenSessionStorageCleanupReferences } from '../../scripts/check-session-storage-r-boundary'

describe('R release cleanup boundary', () => {
  it('allows cleanup protocol definitions and test-only references', () => {
    const violations = findForbiddenSessionStorageCleanupReferences([
      {
        path: 'electron/runtime/sessionStorageCutover.ts',
        source: 'export function clearNextSessionMessageContentBatch() {}',
      },
      {
        path: 'electron/runtime/sessionStorageCutover.test.ts',
        source: 'clearNextSessionMessageContentBatch(db, sessionId)',
      },
    ])

    expect(violations).toEqual([])
  })

  it('rejects production references to any cleanup entry point', () => {
    const violations = findForbiddenSessionStorageCleanupReferences([
      {
        path: 'electron/main.ts',
        source: "import { clearNextSessionMessageContentBatch as clearBatch } from './runtime/sessionStorageCutover'\nclearBatch(db, sessionId)",
      },
      {
        path: 'electron/storage/worker.ts',
        source: 'verifyAndCompleteSessionMessageContentCleanup(db, sessionId)',
      },
    ])

    expect(violations).toEqual([
      {
        path: 'electron/main.ts',
        symbol: 'clearNextSessionMessageContentBatch',
      },
      {
        path: 'electron/storage/worker.ts',
        symbol: 'verifyAndCompleteSessionMessageContentCleanup',
      },
    ])
  })
})
