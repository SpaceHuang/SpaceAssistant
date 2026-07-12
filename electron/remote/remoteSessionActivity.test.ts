import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSession, getSession, openDatabase } from '../database'
import { touchRemoteSessionActivity } from './remoteSessionActivity'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-rsa-'))
}

describe('touchRemoteSessionActivity', () => {
  const dirs: string[] = []
  const openDbs: Array<{ close: () => void }> = []

  afterEach(() => {
    for (const db of openDbs.splice(0)) {
      db.close()
    }
    for (const d of dirs) {
      fs.rmSync(d, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  it('writes remoteSessionLastActivityAt', () => {
    const dbPath = path.join(tempDir(), 'db.db')
    dirs.push(path.dirname(dbPath))
    const db = openDatabase(dbPath)
    openDbs.push(db)
    const session = createSession(db, { name: 'S1' })

    touchRemoteSessionActivity(db, session.id, 1000)
    const updated = getSession(db, session.id)!
    expect((updated.metadata as { remoteSessionLastActivityAt?: number }).remoteSessionLastActivityAt).toBe(1000)
  })

  it('uses max(prev, at) monotonic merge', () => {
    const dbPath = path.join(tempDir(), 'db.db')
    dirs.push(path.dirname(dbPath))
    const db = openDatabase(dbPath)
    openDbs.push(db)
    const session = createSession(db, {
      name: 'S1',
      metadata: { remoteSessionLastActivityAt: 5000 }
    })

    touchRemoteSessionActivity(db, session.id, 3000)
    let updated = getSession(db, session.id)!
    expect((updated.metadata as { remoteSessionLastActivityAt?: number }).remoteSessionLastActivityAt).toBe(5000)

    touchRemoteSessionActivity(db, session.id, 8000)
    updated = getSession(db, session.id)!
    expect((updated.metadata as { remoteSessionLastActivityAt?: number }).remoteSessionLastActivityAt).toBe(8000)
  })
})
