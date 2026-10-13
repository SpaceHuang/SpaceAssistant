import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database'
import { registerPolicyIpc } from './policyIpc'
import { commitImPolicySnapshot, readImPolicySnapshot } from '../confirmation/imPolicyStore'
import { afterEach } from 'vitest'
import { setImAutoReviewTestModeEnabled } from '../confirmation/imAutoReviewTestMode'
import { isRemoteAsyncApprovalTestModeEnabled, setRemoteAsyncApprovalTestModeEnabled } from '../confirmation/remoteAsyncApprovalTestMode'

function registeredHandlers(db = createMemoryAppDb('policy-ipc-contract'), isPackaged = false) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerPolicyIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } as never, db as never, { isPackaged })
  return { db, handlers }
}

describe('policy domain read IPC contract', () => {
  afterEach(() => {
    setImAutoReviewTestModeEnabled(false, false)
    setRemoteAsyncApprovalTestModeEnabled(false, false)
  })

  it('offers an isolated async-approval test switch in development without changing the production gate', async () => {
    const dev = registeredHandlers(createMemoryAppDb('policy-ipc-async-test-switch'), false)
    commitImPolicySnapshot(getDbConnection(dev.db), { policyBehaviorVersion: 'im-standard-v2', snapshot: {}, updatedAt: 1, eventId: 'async-test-switch-seed' })
    const read = dev.handlers.get('policy:read-for-lane')!
    const write = dev.handlers.get('policy:set-im-async-approval-test-mode')!

    expect((await read({}, { lane: 'wechat' })).snapshot).toMatchObject({
      enabled: false, developmentAsyncApprovalTestAvailable: true, developmentAsyncApprovalTestEnabled: false
    })
    await expect(write({}, { enabled: true })).resolves.toEqual({ enabled: true })
    expect(isRemoteAsyncApprovalTestModeEnabled()).toBe(true)
    expect((await read({}, { lane: 'feishu' })).snapshot).toMatchObject({
      enabled: false, developmentAsyncApprovalTestEnabled: true
    })
    expect(getDbConnection(dev.db).prepare('SELECT state FROM remote_async_approval_gate_state WHERE singleton=1').get())
      .toEqual({ state: 'disabled' })
    await expect(write({}, { enabled: false, extra: true })).rejects.toThrow('REMOTE_ASYNC_APPROVAL_TEST_MODE_INVALID')
    dev.db.close()

    const packaged = registeredHandlers(createMemoryAppDb('policy-ipc-async-test-packaged'), true)
    commitImPolicySnapshot(getDbConnection(packaged.db), { policyBehaviorVersion: 'im-standard-v2', snapshot: {}, updatedAt: 1, eventId: 'async-test-packaged-seed' })
    await expect(packaged.handlers.get('policy:set-im-async-approval-test-mode')!({}, { enabled: true }))
      .rejects.toThrow('REMOTE_ASYNC_APPROVAL_TEST_MODE_UNAVAILABLE')
    expect((await packaged.handlers.get('policy:read-for-lane')!({}, { lane: 'wechat' })).snapshot)
      .toMatchObject({ enabled: false, developmentAsyncApprovalTestAvailable: false, developmentAsyncApprovalTestEnabled: false })
    packaged.db.close()
  })

  it('offers a process-only auto-review test switch in development and refuses it in packaged builds', async () => {
    const dev = registeredHandlers(createMemoryAppDb('policy-ipc-dev-switch'), false)
    commitImPolicySnapshot(getDbConnection(dev.db), { policyBehaviorVersion: 'im-standard-v2', snapshot: {}, updatedAt: 1, eventId: 'dev-switch-seed' })
    const read = dev.handlers.get('policy:read-for-lane')!
    const write = dev.handlers.get('policy:set-im-auto-review-test-mode')!
    expect((await read({}, { lane: 'wechat' })).snapshot).toMatchObject({
      enabled: false, developmentAutoReviewTestAvailable: true, developmentAutoReviewTestEnabled: false
    })
    await expect(write({}, { enabled: true })).resolves.toEqual({ enabled: true })
    expect((await read({}, { lane: 'feishu' })).snapshot.developmentAutoReviewTestEnabled).toBe(true)
    expect(getDbConnection(dev.db).prepare('SELECT COUNT(*) AS count FROM policy_audit_events').get()).toEqual({ count: 1 })
    await expect(write({}, { enabled: true, extra: true })).rejects.toThrow('IM_AUTO_REVIEW_TEST_MODE_INVALID')
    dev.db.close()

    const packaged = registeredHandlers(createMemoryAppDb('policy-ipc-packaged-switch'), true)
    commitImPolicySnapshot(getDbConnection(packaged.db), { policyBehaviorVersion: 'im-standard-v2', snapshot: {}, updatedAt: 1, eventId: 'packaged-switch-seed' })
    await expect(packaged.handlers.get('policy:set-im-auto-review-test-mode')!({}, { enabled: true }))
      .rejects.toThrow('IM_AUTO_REVIEW_TEST_MODE_UNAVAILABLE')
    expect((await packaged.handlers.get('policy:read-for-lane')!({}, { lane: 'wechat' })).snapshot)
      .toMatchObject({ developmentAutoReviewTestAvailable: false, developmentAutoReviewTestEnabled: false })
    packaged.db.close()
  })
  it('maps desktop, WeChat, and Feishu views to their trusted domains and returns one shared IM snapshot', async () => {
    const { db, handlers } = registeredHandlers()
    const conn = getDbConnection(db)
    conn.prepare("INSERT INTO policy_behavior_snapshots VALUES('desktop','desktop-v1',3,'{\"package\":\"standard\"}',1)").run()
    conn.prepare("INSERT INTO policy_behavior_snapshots VALUES('im','im-standard-v2',7,'{\"package\":\"standard\"}',1)").run()
    const read = handlers.get('policy:read-for-lane')!
    const desktop = await read({}, { lane: 'desktop' })
    const wechat = await read({}, { lane: 'wechat' })
    const feishu = await read({}, { lane: 'feishu' })
    expect(desktop).toMatchObject({ domain: 'desktop', revision: 3 })
    expect(wechat).toMatchObject({ domain: 'im', policyBehaviorVersion: 'im-standard-v2', revision: 7 })
    expect(wechat.snapshot.enabled).toBe(false)
    expect(feishu).toEqual(wechat)
    db.close()
  })

  it('rejects unknown lanes and caller-selected or unknown domains', async () => {
    const { db, handlers } = registeredHandlers()
    const read = handlers.get('policy:read-for-lane')!
    await expect(read({}, { lane: 'automation' })).rejects.toThrow('POLICY_LANE_UNSUPPORTED')
    await expect(read({}, { lane: 'wechat', domain: 'desktop' })).rejects.toThrow('POLICY_DOMAIN_MUST_NOT_BE_SPECIFIED')
    await expect(read({}, { lane: 'desktop', domain: 'unknown' })).rejects.toThrow('POLICY_DOMAIN_MUST_NOT_BE_SPECIFIED')
    db.close()
  })

  it('rejects invalid package and action enums plus immutable rule changes without writing', async () => {
    const { db, handlers } = registeredHandlers()
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { package: 'standard', ruleOverrides: {} }, updatedAt: 1, eventId: 'seed-write' })
    const write = handlers.get('policy:write')!
    const before = readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] })
    await expect(write({}, { lane: 'wechat', expectedRevision: before.revision, change: { kind: 'package', package: 'turbo' } })).rejects.toThrow('POLICY_PACKAGE_INVALID')
    await expect(write({}, { lane: 'wechat', expectedRevision: before.revision, change: { kind: 'rule-override', ruleId: 'remote-outside-write-deny', action: 'allow' } })).rejects.toThrow('POLICY_RULE_IMMUTABLE')
    await expect(write({}, { lane: 'wechat', expectedRevision: before.revision, change: { kind: 'rule-override', ruleId: 'script-unmodeled-path-ask', action: 'maybe' } })).rejects.toThrow('POLICY_ACTION_INVALID')
    await expect(write({}, { lane: 'wechat', expectedRevision: before.revision, change: { kind: 'capability-permission', capabilityId: 'env.system', permission: 'superuser' } })).rejects.toThrow('POLICY_PERMISSION_INVALID')
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] })).toEqual(before)
    expect(conn.prepare('SELECT COUNT(*) AS count FROM policy_audit_events').get()).toEqual({ count: 1 })
    db.close()
  })

  it('returns a revision conflict without changing snapshot, authorization epoch, or audit', async () => {
    const { db, handlers } = registeredHandlers()
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { package: 'standard' }, updatedAt: 1, eventId: 'seed-cas' })
    const write = handlers.get('policy:write')!
    const result = await write({}, { lane: 'wechat', expectedRevision: 0, change: { kind: 'package', package: 'strict' } })
    expect(result).toMatchObject({ status: 'conflict', currentRevision: 1 })
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] })).toMatchObject({ revision: 1, snapshot: { package: 'standard' } })
    expect(conn.prepare("SELECT epoch FROM policy_authorization_epochs WHERE domain='im'").get()).toEqual({ epoch: 1 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM policy_audit_events').get()).toEqual({ count: 1 })
    db.close()
  })

  it('commits a valid shared IM policy change with revision, epoch invalidation, and audit', async () => {
    const { db, handlers } = registeredHandlers()
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' }, updatedAt: 1, eventId: 'seed-valid' })
    const result = await handlers.get('policy:write')!({}, {
      lane: 'feishu', expectedRevision: 1, change: { kind: 'package', package: 'strict' }
    })
    expect(result).toMatchObject({ status: 'committed', revision: 2 })
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] })).toMatchObject({
      revision: 2, snapshot: { selectedPackage: 'strict' }
    })
    expect(conn.prepare("SELECT epoch FROM policy_authorization_epochs WHERE domain='im'").get()).toEqual({ epoch: 2 })
    expect(conn.prepare("SELECT COUNT(*) AS count FROM policy_audit_events WHERE domain='im'").get()).toEqual({ count: 2 })
    db.close()
  })

  it('stores a validated declared capability permission in the same shared policy snapshot', async () => {
    const { db, handlers } = registeredHandlers()
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: {}, updatedAt: 1, eventId: 'seed-capability' })
    const result = await handlers.get('policy:write')!({}, {
      lane: 'wechat', expectedRevision: 1,
      change: { kind: 'capability-permission', capabilityId: 'env.system', permission: 'ask' }
    })
    expect(result).toMatchObject({ status: 'committed', revision: 2 })
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] })).toMatchObject({
      snapshot: { capabilityPermissions: { 'env.system': 'ask' } }
    })
    db.close()
  })

  it('switches a legacy IM snapshot to the current standard only after explicit confirmation of all displayed differences', async () => {
    const { db, handlers } = registeredHandlers()
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, {
      policyBehaviorVersion: 'im-v1.6',
      snapshot: { legacyBehavior: { packages: { standard: { pkg: 'standard', rules: [] } } } },
      updatedAt: 1, eventId: 'seed-legacy-switch'
    })
    const change = handlers.get('policy:write')!
    const displayedDiffs = [
      'mcp-public-read-auto',
      'low-risk-browser-and-feishu-auto',
      'sensitive-write-and-external-outbound-manual'
    ]
    await expect(change({}, {
      lane: 'wechat', expectedRevision: 1, change: { kind: 'switch-to-standard', userChoiceConfirmed: false, displayedDiffs }
    })).rejects.toThrow('POLICY_BEHAVIOR_SWITCH_CONFIRMATION_REQUIRED')
    const result = await change({}, {
      lane: 'wechat', expectedRevision: 1, change: { kind: 'switch-to-standard', userChoiceConfirmed: true, displayedDiffs }
    })
    expect(result).toMatchObject({ status: 'committed', revision: 2 })
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] })).toMatchObject({
      policyBehaviorVersion: 'im-standard-v2', revision: 2,
      snapshot: { selectedPackage: 'standard', explicitBehaviorSwitch: true, displayedBehaviorDiffs: displayedDiffs }
    })
    db.close()
  })

  it('resets editable overrides and toggles only locked deny rules in the common snapshot', async () => {
    const { db, handlers } = registeredHandlers()
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, {
      policyBehaviorVersion: 'im-standard-v2',
      snapshot: { ruleOverrides: { 'im-write-ask': 'allow' }, disabledRuleIds: [] },
      updatedAt: 1, eventId: 'seed-reset-toggle'
    })
    const write = handlers.get('policy:write')!
    await write({}, { lane: 'wechat', expectedRevision: 1, change: { kind: 'rule-reset', ruleId: 'im-write-ask' } })
    await write({}, { lane: 'feishu', expectedRevision: 2, change: { kind: 'rule-enabled', ruleId: 'remote-shell-disabled', enabled: false } })
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] })).toMatchObject({
      revision: 3, snapshot: { ruleOverrides: {}, disabledRuleIds: ['remote-shell-disabled'] }
    })
    await expect(write({}, {
      lane: 'wechat', expectedRevision: 3, change: { kind: 'rule-enabled', ruleId: 'im-write-ask', enabled: false }
    })).rejects.toThrow('POLICY_RULE_ENABLE_INVALID')
    db.close()
  })
})
