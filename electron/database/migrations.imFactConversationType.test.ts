import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryAppDb } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { runMigrations } from './migrations'
import { DB_SCHEMA_VERSION, SCHEMA_META_KEYS } from './schema'
import { createSession } from './operations'
import { appendImInboxMessage } from './imInbox'
import { buildImQueueScope } from '../../src/shared/queueScope'

describe('IM accepted fact conversation type migration', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined
  afterEach(() => { db?.close(); db = undefined })

  it('adds the trusted group flag and immutability guard when upgrading a v121 database', () => {
    db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = createSession(db, { name: 'v121-im-fact' }).id
    appendImInboxMessage(db, { sessionId, channel: 'feishu', queueScope: buildImQueueScope('feishu', sessionId), channelMessageId: 'legacy-v121',
      accountId: 'account', conversationId: 'chat', senderId: 'alice', content: 'legacy', isGroup: false })
    conn.exec('DROP TRIGGER guard_im_fact_identity_immutable; ALTER TABLE im_inbox_message_context DROP COLUMN is_group;')
    conn.prepare('UPDATE schema_meta SET value=? WHERE key=?').run('121', SCHEMA_META_KEYS.schemaVersion)

    runMigrations(conn)

    expect(conn.prepare('PRAGMA table_info(im_inbox_message_context)').all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'is_group' })
    ]))
    expect(conn.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion)).toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(() => conn.prepare('UPDATE im_inbox_message_context SET is_group=1 WHERE accepted_seq IS NOT NULL').run())
      .toThrow('accepted IM fact identity is immutable')
  })
})
