import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { recordRemoteTrackDiagnosticEvent, readRemoteTrackDiagnosticEvents } from './remoteTrackDiagnosticStore'

describe('remote Track diagnostic events', () => {
  it('persists only closed diagnostic facts and is idempotent per channel/message/kind', () => {
    const db = createMemoryAppDb()
    try {
      expect(recordRemoteTrackDiagnosticEvent(db, { channel: 'wechat', platformMessageId: 'reply-1',
        eventKind: 'clarification.reply', reasonCode: 'stale', occurredAt: 10 })).toBe(true)
      expect(recordRemoteTrackDiagnosticEvent(db, { channel: 'wechat', platformMessageId: 'reply-1',
        eventKind: 'clarification.reply', reasonCode: 'stale', occurredAt: 10 })).toBe(false)
      expect(readRemoteTrackDiagnosticEvents(db, { from: 10, to: 11 })).toEqual([{
        channel: 'wechat', platformMessageId: 'reply-1', eventKind: 'clarification.reply', reasonCode: 'stale', occurredAt: 10
      }])
      const raw = getDbConnection(db).prepare('SELECT * FROM remote_track_diagnostic_events').get() as Record<string, unknown>
      expect(Object.keys(raw)).not.toContain('content')
      expect(Object.keys(raw)).not.toContain('identity_key')
    } finally { db.close() }
  })

  it('rejects unrecognized event and reason codes', () => {
    const db = createMemoryAppDb()
    try {
      expect(() => recordRemoteTrackDiagnosticEvent(db, { channel: 'wechat', platformMessageId: 'reply-2',
        eventKind: 'free-form' as never, reasonCode: 'stale', occurredAt: 10 })).toThrow('REMOTE_TRACK_DIAGNOSTIC_EVENT_INVALID')
      expect(() => recordRemoteTrackDiagnosticEvent(db, { channel: 'wechat', platformMessageId: 'reply-2',
        eventKind: 'clarification.reply', reasonCode: 'raw-user-text' as never, occurredAt: 10 })).toThrow('REMOTE_TRACK_DIAGNOSTIC_EVENT_INVALID')
    } finally { db.close() }
  })

  it('validates half-open time windows', () => {
    const db = createMemoryAppDb()
    try {
      expect(() => readRemoteTrackDiagnosticEvents(db, { from: 10, to: 10 })).toThrow('REMOTE_TRACK_DIAGNOSTIC_RANGE_INVALID')
    } finally { db.close() }
  })
})
