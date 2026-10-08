import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryAppDb } from './database/testHelpers'
import { appendMessage, createSession } from './database/operations'
import { createSqliteSessionStorage } from './sessionStorage/sqliteSessionStorage'
import { DebouncedSessionBackupManager } from './debouncedSessionBackupManager'
import { SessionBackupManager } from './sessionBackupManager'
import { flushPendingSessionBackups } from './sessionBackupShutdown'

let workDir: string | undefined
afterEach(async () => { if (workDir) await fs.rm(workDir, { recursive: true, force: true }); workDir = undefined })

describe('shutdown session backup flush', () => {
  it('flushes a pending session using the supplied SessionQueries before database shutdown', async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-shutdown-backup-'))
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'pending backup', model: 'test' })
      appendMessage(db, { id: 'pending-backup-message', sessionId: session.id, role: 'user', content: 'still pending', timestamp: 1, status: 'sent' })
      const storage = createSqliteSessionStorage(db)
      const manager = new DebouncedSessionBackupManager(new SessionBackupManager(workDir))
      manager.schedule(session.id, async () => null)

      await flushPendingSessionBackups(manager, storage.queries)

      const date = new Date(session.createdAt).toISOString().slice(0, 10).replace(/-/g, '')
      const content = JSON.parse(await fs.readFile(path.join(workDir, 'sessions', `${session.id}-${date}`, 'messages.json'), 'utf8'))
      expect(content.messages).toHaveLength(1)
      expect(content.messages[0]).toMatchObject({ id: 'pending-backup-message', content: 'still pending' })
      expect(manager.getPendingSessionIds()).toEqual([])
    } finally {
      db.close()
    }
  })
})
