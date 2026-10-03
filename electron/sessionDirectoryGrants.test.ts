import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../src/shared/domainTypes'
import { addSessionDirectoryGrant, listSessionDirectoryGrants, listValidSessionDirectoryGrantsSync, removeSessionDirectoryGrant } from './sessionDirectoryGrants'

const tempRoots: string[] = []
async function makeDirectory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-directory-grant-'))
  tempRoots.push(root)
  return root
}
function makeSession(id: string, metadata: Record<string, unknown> = {}): Session {
  return { id, name: id, preview: '', model: 'test', temperature: 0, maxTokens: 1, createdAt: 1, updatedAt: 1, messageCount: 0, skillsState: {}, metadata, schemaVersion: 1 }
}
afterEach(async () => { await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

describe('session directory grants', () => {
  it('creates a grant only from a selected existing directory and persists real identity', async () => {
    const root = await makeDirectory()
    let session = makeSession('s1')
    const update = vi.fn((next: Session) => { session = next })
    const result = await addSessionDirectoryGrant({ session, selectDirectory: async () => root, updateSession: update, isSensitivePath: () => false })
    expect(result).toMatchObject({ status: 'added', grant: { sessionId: 's1', path: await fs.realpath(root), source: 'user-selected-directory' } })
    expect(update).toHaveBeenCalledOnce()
    expect((session.metadata.sessionDirectoryGrants as unknown[])).toHaveLength(1)
  })

  it('does not persist on cancellation, invalid target, sensitive target, or duplicate canonical path', async () => {
    const root = await makeDirectory()
    const session = makeSession('s1')
    const update = vi.fn()
    await expect(addSessionDirectoryGrant({ session, selectDirectory: async () => undefined, updateSession: update, isSensitivePath: () => false })).resolves.toEqual({ status: 'canceled' })
    await expect(addSessionDirectoryGrant({ session, selectDirectory: async () => path.join(root, 'missing'), updateSession: update, isSensitivePath: () => false })).resolves.toMatchObject({ status: 'invalid-directory' })
    await expect(addSessionDirectoryGrant({ session, selectDirectory: async () => root, updateSession: update, isSensitivePath: () => true })).resolves.toMatchObject({ status: 'sensitive-directory' })
    const added = await addSessionDirectoryGrant({ session, selectDirectory: async () => root, updateSession: (next) => { session.metadata = next.metadata }, isSensitivePath: () => false })
    const duplicate = await addSessionDirectoryGrant({ session, selectDirectory: async () => `${root}/.`, updateSession: update, isSensitivePath: () => false })
    expect(added.status).toBe('added')
    expect(duplicate).toMatchObject({ status: 'already-granted', grant: { sessionId: 's1' } })
    expect(update).not.toHaveBeenCalled()
  })

  it('lists only the requested session and removes only the matching grant', async () => {
    const rootA = await makeDirectory()
    const rootB = await makeDirectory()
    let sessionA = makeSession('a')
    let sessionB = makeSession('b')
    const update = (id: string) => (next: Session) => { if (id === 'a') sessionA = next; else sessionB = next }
    const grantA = await addSessionDirectoryGrant({ session: sessionA, selectDirectory: async () => rootA, updateSession: update('a'), isSensitivePath: () => false })
    await addSessionDirectoryGrant({ session: sessionB, selectDirectory: async () => rootB, updateSession: update('b'), isSensitivePath: () => false })
    expect(await listSessionDirectoryGrants(sessionA)).toHaveLength(1)
    expect((await listSessionDirectoryGrants(sessionA))[0]?.sessionId).toBe('a')
    expect(removeSessionDirectoryGrant({ session: sessionA, grantId: (grantA as { grant: { grantId: string } }).grant.grantId, updateSession: update('a') })).toBe(true)
    expect(await listSessionDirectoryGrants(sessionA)).toHaveLength(0)
    expect(await listSessionDirectoryGrants(sessionB)).toHaveLength(1)
  })

  it('marks a grant invalid when its canonical path or directory identity changes', async () => {
    const root = await makeDirectory()
    let session = makeSession('s1')
    await addSessionDirectoryGrant({ session, selectDirectory: async () => root, updateSession: (next) => { session = next }, isSensitivePath: () => false })
    await fs.rm(root, { recursive: true })
    await expect(listSessionDirectoryGrants(session)).resolves.toMatchObject([{ status: 'invalid' }])
  })

  it('does not let an old grant survive directory replacement at the same path', async () => {
    const root = await makeDirectory()
    let session = makeSession('s1')
    await addSessionDirectoryGrant({ session, selectDirectory: async () => root, updateSession: (next) => { session = next }, isSensitivePath: () => false })
    const moved = `${root}-moved`
    await fs.rename(root, moved)
    await fs.mkdir(root)
    expect(await listSessionDirectoryGrants(session)).toMatchObject([{ status: 'invalid' }])
    expect(listValidSessionDirectoryGrantsSync(session)).toEqual([])
  })

  it('replaces a stale grant identity when the user selects the replacement directory', async () => {
    const root = await makeDirectory()
    let session = makeSession('s1')
    await addSessionDirectoryGrant({ session, selectDirectory: async () => root, updateSession: (next) => { session = next }, isSensitivePath: () => false })
    const moved = `${root}-moved`
    await fs.rename(root, moved)
    await fs.mkdir(root)

    const result = await addSessionDirectoryGrant({ session, selectDirectory: async () => root, updateSession: (next) => { session = next }, isSensitivePath: () => false })

    expect(result.status).toBe('added')
    expect(await listSessionDirectoryGrants(session)).toMatchObject([{ status: 'valid', path: await fs.realpath(root) }])
    expect((session.metadata.sessionDirectoryGrants as unknown[])).toHaveLength(1)
  })
})
