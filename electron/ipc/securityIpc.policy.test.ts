import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database'
import { registerSecurityIpc } from './securityIpc'
import type { AppIpcContext } from '../appIpc'
import { commitDesktopPolicySnapshot, readPolicyBehaviorSnapshot } from '../confirmation/imPolicyStore'

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
  it('does not expose the legacy toggle handler after renderer migration', () => {
    const { handlers } = registerHandlers()
    expect(handlers.has('security:set-rule-enabled')).toBe(false)
  })

  it('clears a desktop migration badge after an explicit action update', async () => {
    const { db, handlers } = registerHandlers()
    const conn = getDbConnection(db)
    commitDesktopPolicySnapshot(conn, { policyBehaviorVersion: 'desktop-v1', snapshot: {
      selectedPackage: 'custom', ruleOverrides: { 'remote-shell-disabled': 'allow' },
      migratedLegacyDisabledRuleIds: ['remote-shell-disabled']
    }, updatedAt: 1, eventId: 'desktop-migration-badge-seed' })
    const result = await handlers.get('security:set-rule-override')!({}, {
      ruleId: 'remote-shell-disabled', action: 'ask', lane: 'desktop', expectedRevision: 1
    })
    expect(result).toMatchObject({ ok: true })
    expect(readPolicyBehaviorSnapshot(conn, 'desktop', { supportedBehaviorVersions: ['desktop-v1'] }).snapshot.migratedLegacyDisabledRuleIds).toEqual([])
  })
})
