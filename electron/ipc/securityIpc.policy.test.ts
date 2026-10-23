import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database'
import { registerSecurityIpc } from './securityIpc'
import type { AppIpcContext } from '../appIpc'
import { commitDesktopPolicySnapshot, readPolicyBehaviorSnapshot } from '../confirmation/imPolicyStore'
import { getDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'

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
      migratedLegacyDisabledRuleIds: ['remote-shell-disabled'], legacyDesktopPolicyDataMigrated: true
    }, updatedAt: 1, eventId: 'desktop-migration-badge-seed' })
    const result = await handlers.get('security:set-rule-override')!({}, {
      ruleId: 'remote-shell-disabled', action: 'ask', lane: 'desktop', expectedRevision: 1
    })
    expect(result).toMatchObject({ ok: true })
    expect(readPolicyBehaviorSnapshot(conn, 'desktop', { supportedBehaviorVersions: ['desktop-v1'] }).snapshot.migratedLegacyDisabledRuleIds).toEqual([])
  })

  it('rejects stale desktop package writes without changing snapshot, epoch, audit, or broadcasts', async () => {
    const { db, handlers } = registerHandlers()
    const setPackage = handlers.get('security:set-policy-package')!
    const publish = vi.spyOn(getDefaultAgentRuntime().policyAuthorizationChanges, 'publish')
    try {
      const first = await setPackage({}, { lane: 'desktop', package: 'custom', expectedRevision: 0 })
      expect(first).toMatchObject({ ok: true, revision: 1 })
      expect(publish).toHaveBeenCalledTimes(1)
      expect(publish).toHaveBeenCalledWith('desktop')
      const before = readPolicyBehaviorSnapshot(getDbConnection(db), 'desktop', { supportedBehaviorVersions: ['desktop-v1'] })
      const beforeEpoch = getDbConnection(db).prepare("SELECT epoch FROM policy_authorization_epochs WHERE domain='desktop'").get()
      const beforeAuditCount = getDbConnection(db).prepare("SELECT COUNT(*) AS count FROM policy_audit_events WHERE domain='desktop'").get()

      const stale = await setPackage({}, { lane: 'desktop', package: 'standard', expectedRevision: 0 })

      expect(stale).toMatchObject({ ok: false, error: 'POLICY_REVISION_CONFLICT', currentRevision: 1 })
      expect(readPolicyBehaviorSnapshot(getDbConnection(db), 'desktop', { supportedBehaviorVersions: ['desktop-v1'] })).toEqual(before)
      expect(getDbConnection(db).prepare("SELECT epoch FROM policy_authorization_epochs WHERE domain='desktop'").get()).toEqual(beforeEpoch)
      expect(getDbConnection(db).prepare("SELECT COUNT(*) AS count FROM policy_audit_events WHERE domain='desktop'").get()).toEqual(beforeAuditCount)
      expect(publish).toHaveBeenCalledTimes(1)
    } finally {
      publish.mockRestore()
    }
  })
})
