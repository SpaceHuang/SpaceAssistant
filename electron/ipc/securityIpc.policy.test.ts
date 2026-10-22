import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database'
import { registerSecurityIpc } from './securityIpc'
import type { AppIpcContext } from '../appIpc'
import { readPolicyBehaviorSnapshot } from '../confirmation/imPolicyStore'

const dbs: ReturnType<typeof createMemoryAppDb>[] = []
afterEach(() => dbs.splice(0).forEach((db) => db.close()))

function registerHandlers() {
  const db = createMemoryAppDb('security-ipc-policy-contract')
  dbs.push(db)
  const registered = new Map<string, (...args: unknown[]) => unknown>()
  const ctx = { db, getWorkDir: () => '/tmp', getUserDataPath: () => '/tmp',
    backup: {}, workDirManager: {}, setWorkDir: () => undefined, getApiKey: async () => null,
    setApiKey: async () => undefined, getBrowserDetectContext: () => ({ isPackaged: false, appPath: '/tmp', devRoot: '/tmp' }) } as unknown as AppIpcContext
  registerSecurityIpc({ handle: (channel: string, fn: (...args: unknown[]) => unknown) => registered.set(channel, fn) } as never, ctx)
  return { db, handlers: registered }
}

describe('security policy action API compatibility contract', () => {
  it('keeps the legacy toggle handler during T4/T7 compatibility window', () => {
    const { handlers } = registerHandlers()
    expect(handlers.has('security:set-rule-enabled')).toBe(true)
  })

  it('maps legacy disabled to allow and enabled to reset-default through policy snapshots', async () => {
    const { db, handlers } = registerHandlers()
    const toggle = handlers.get('security:set-rule-enabled')!
    const ruleId = 'remote-outside-read-deny'
    await toggle({}, { ruleId, enabled: false })
    expect(readPolicyBehaviorSnapshot(getDbConnection(db), 'desktop', { supportedBehaviorVersions: ['desktop-v1'] }).snapshot.ruleOverrides)
      .toMatchObject({ [ruleId]: 'allow' })

    await toggle({}, { ruleId, enabled: true })
    expect(readPolicyBehaviorSnapshot(getDbConnection(db), 'desktop', { supportedBehaviorVersions: ['desktop-v1'] }).snapshot.ruleOverrides)
      .not.toHaveProperty(ruleId)
  })
})
