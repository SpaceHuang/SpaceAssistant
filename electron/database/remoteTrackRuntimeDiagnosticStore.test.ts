import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from './testHelpers'
import { readRemoteTrackRuntimeDiagnostics, recordRemoteTrackRuntimeDiagnostic } from './remoteTrackRuntimeDiagnosticStore'

describe('remote Track runtime diagnostics', () => {
  it('persists only closed codes and message ids, idempotently', () => {
    const db = createMemoryAppDb()
    try {
      const input = { channel: 'wechat' as const, platformMessageId: 'message-1', eventKind: 'untracked-runtime-invocation' as const,
        reasonCode: 'track-context-missing' as const, occurredAt: 10 }
      expect(recordRemoteTrackRuntimeDiagnostic(db, input)).toBe(true)
      expect(recordRemoteTrackRuntimeDiagnostic(db, input)).toBe(false)
      expect(readRemoteTrackRuntimeDiagnostics(db, { from: 10, to: 11 })).toEqual([input])
      expect(() => recordRemoteTrackRuntimeDiagnostic(db, { ...input, reasonCode: 'message body' as never })).toThrow('REMOTE_TRACK_RUNTIME_DIAGNOSTIC_INVALID')
    } finally { db.close() }
  })
})
