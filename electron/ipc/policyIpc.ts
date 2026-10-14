import type { IpcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type { AppDatabase } from '../database'
import { getDbConnection } from '../database'
import { readPolicyBehaviorSnapshot } from '../confirmation/imPolicyStore'
import { commitImPolicySnapshot, readImPolicySnapshot, switchToCurrentImStandard } from '../confirmation/imPolicyStore'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { isPolicyPackage, validateRuleOverride } from '../../src/shared/policy/policyPackages'
import { IM_STANDARD_BEHAVIOR_DIFF_IDS } from '../../src/shared/policy/imPolicyBehavior'
import { isRemoteAsyncApprovalGateEnabled } from '../confirmation/remoteAsyncApprovalGate'
import type { PolicyAction } from '../../src/shared/confirmation/types'
import { LEGACY_IM_POLICY_MIGRATION_VERSION } from '../../src/shared/policy/legacyPolicyMigration'
import '../capabilities/registerBuiltinCapabilities'
import { capabilityRegistry } from '../capabilities/registry'

type PolicyLane = 'desktop' | 'wechat' | 'feishu'

const DOMAIN_BY_LANE: Readonly<Record<PolicyLane, 'desktop' | 'im'>> = {
  desktop: 'desktop',
  wechat: 'im',
  feishu: 'im'
}

const SUPPORTED_BEHAVIOR_VERSIONS: Readonly<Record<'desktop' | 'im', readonly string[]>> = {
  desktop: ['desktop-v1'],
  im: ['im-v1.6', 'im-standard-v2']
}

export function policyDomainForLane(lane: unknown): 'desktop' | 'im' {
  if (typeof lane !== 'string' || !Object.hasOwn(DOMAIN_BY_LANE, lane)) throw new Error('POLICY_LANE_UNSUPPORTED')
  return DOMAIN_BY_LANE[lane as PolicyLane]
}

export function registerPolicyIpc(ipcMain: IpcMain, db: AppDatabase): void {
  ipcMain.handle('policy:read-for-lane', async (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('POLICY_READ_PAYLOAD_INVALID')
    const request = payload as Record<string, unknown>
    if (Object.hasOwn(request, 'domain')) throw new Error('POLICY_DOMAIN_MUST_NOT_BE_SPECIFIED')
    const domain = policyDomainForLane(request.lane)
    const policy = readPolicyBehaviorSnapshot(getDbConnection(db), domain, {
      supportedBehaviorVersions: SUPPORTED_BEHAVIOR_VERSIONS[domain]
    })
    if (domain !== 'im') return policy
    return { ...policy, snapshot: { ...policy.snapshot, enabled: isRemoteAsyncApprovalGateEnabled(db) } }
  })
  ipcMain.handle('policy:write', async (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('POLICY_WRITE_PAYLOAD_INVALID')
    const request = payload as Record<string, unknown>
    const domain = policyDomainForLane(request.lane)
    if (domain !== 'im') throw new Error('POLICY_WRITE_DOMAIN_UNSUPPORTED')
    if (Object.hasOwn(request, 'domain')) throw new Error('POLICY_DOMAIN_MUST_NOT_BE_SPECIFIED')
    if (!Number.isSafeInteger(request.expectedRevision) || (request.expectedRevision as number) < 0) throw new Error('POLICY_REVISION_INVALID')
    if (!request.change || typeof request.change !== 'object' || Array.isArray(request.change)) throw new Error('POLICY_CHANGE_INVALID')
    const change = request.change as Record<string, unknown>
    const current = readImPolicySnapshot(getDbConnection(db), { supportedBehaviorVersions: SUPPORTED_BEHAVIOR_VERSIONS.im })
    if (change.kind === 'switch-to-standard') {
      if (change.userChoiceConfirmed !== true || !Array.isArray(change.displayedDiffs) ||
          JSON.stringify(change.displayedDiffs) !== JSON.stringify(IM_STANDARD_BEHAVIOR_DIFF_IDS)) {
        throw new Error('POLICY_BEHAVIOR_SWITCH_CONFIRMATION_REQUIRED')
      }
      if (current.policyBehaviorVersion === 'im-standard-v2') throw new Error('POLICY_BEHAVIOR_ALREADY_CURRENT')
      if (request.expectedRevision !== current.revision) return { status: 'conflict', currentRevision: current.revision }
      return switchToCurrentImStandard(getDbConnection(db), {
        userChoiceConfirmed: true,
        displayedDiffs: IM_STANDARD_BEHAVIOR_DIFF_IDS,
        updatedAt: Date.now(),
        eventId: `policy-ipc:${randomUUID()}`
      })
    }
    const snapshot = structuredClone(current.snapshot)
    if (change.kind === 'package') {
      if (!isPolicyPackage(change.package)) throw new Error('POLICY_PACKAGE_INVALID')
      snapshot.selectedPackage = change.package
    } else if (change.kind === 'rule-override') {
      if (typeof change.ruleId !== 'string' || !change.ruleId) throw new Error('POLICY_RULE_ID_INVALID')
      const validation = validateRuleOverride(DEFAULT_POLICY_RULES, change.ruleId, change.action, request.lane as 'wechat' | 'feishu')
      if (!validation.ok) {
        if (validation.error.startsWith('rule is locked:')) throw new Error('POLICY_RULE_IMMUTABLE')
        if (validation.error.startsWith('unknown rule:')) throw new Error('POLICY_RULE_UNKNOWN')
        throw new Error('POLICY_ACTION_INVALID')
      }
      const overrides = snapshot.ruleOverrides && typeof snapshot.ruleOverrides === 'object' && !Array.isArray(snapshot.ruleOverrides)
        ? snapshot.ruleOverrides as Record<string, unknown> : {}
      overrides[change.ruleId] = change.action as PolicyAction
      snapshot.ruleOverrides = overrides
      const resetIds = new Set(Array.isArray(snapshot.legacyRuleResetIds)
        ? snapshot.legacyRuleResetIds.filter((id): id is string => typeof id === 'string') : [])
      resetIds.delete(change.ruleId)
      if (resetIds.size > 0) snapshot.legacyRuleResetIds = [...resetIds]
      else delete snapshot.legacyRuleResetIds
    } else if (change.kind === 'rule-reset') {
      if (typeof change.ruleId !== 'string' || !change.ruleId) throw new Error('POLICY_RULE_ID_INVALID')
      if (!DEFAULT_POLICY_RULES.some((rule) => rule.id === change.ruleId && !rule.locked)) throw new Error('POLICY_RULE_IMMUTABLE')
      const overrides = snapshot.ruleOverrides && typeof snapshot.ruleOverrides === 'object' && !Array.isArray(snapshot.ruleOverrides)
        ? snapshot.ruleOverrides as Record<string, unknown> : {}
      delete overrides[change.ruleId]
      snapshot.ruleOverrides = overrides
      if (snapshot.legacyPolicyMigrationVersion !== LEGACY_IM_POLICY_MIGRATION_VERSION) {
        const resetIds = new Set(Array.isArray(snapshot.legacyRuleResetIds)
          ? snapshot.legacyRuleResetIds.filter((id): id is string => typeof id === 'string') : [])
        resetIds.add(change.ruleId)
        snapshot.legacyRuleResetIds = [...resetIds]
      }
    } else if (change.kind === 'rule-enabled') {
      const rule = DEFAULT_POLICY_RULES.find((entry) => entry.id === change.ruleId)
      if (!rule?.locked || rule.action !== 'deny' || typeof change.enabled !== 'boolean') throw new Error('POLICY_RULE_ENABLE_INVALID')
      const disabled = new Set(Array.isArray(snapshot.disabledRuleIds)
        ? snapshot.disabledRuleIds.filter((id): id is string => typeof id === 'string') : [])
      if (change.enabled) disabled.delete(rule.id)
      else disabled.add(rule.id)
      snapshot.disabledRuleIds = [...disabled]
    } else if (change.kind === 'capability-permission') {
      if (typeof change.capabilityId !== 'string' || !capabilityRegistry.get(change.capabilityId)) throw new Error('POLICY_CAPABILITY_UNKNOWN')
      if (change.permission !== 'deny' && change.permission !== 'ask' && change.permission !== 'allow') throw new Error('POLICY_PERMISSION_INVALID')
      const permissions = snapshot.capabilityPermissions && typeof snapshot.capabilityPermissions === 'object' && !Array.isArray(snapshot.capabilityPermissions)
        ? snapshot.capabilityPermissions as Record<string, unknown> : {}
      permissions[change.capabilityId] = change.permission
      snapshot.capabilityPermissions = permissions
    } else throw new Error('POLICY_CHANGE_KIND_INVALID')
    const result = commitImPolicySnapshot(getDbConnection(db), {
      expectedRevision: request.expectedRevision as number,
      policyBehaviorVersion: current.policyBehaviorVersion,
      snapshot,
      updatedAt: Date.now(),
      eventId: `policy-ipc:${randomUUID()}`,
      eventKind: 'policy-snapshot-updated',
      auditMetadata: { lane: request.lane, changeKind: change.kind }
    })
    return result
  })
}
