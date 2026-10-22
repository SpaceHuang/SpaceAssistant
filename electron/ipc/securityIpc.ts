// Phase 2 拆分:本文件自 appIpc.ts 纯移动而来,通道名与行为不变(driver-authority-refactor Phase 2)。
import path from 'path'
import { randomUUID } from 'node:crypto'
import type { AppIpcContext } from '../appIpc'
import type { IpcMain } from 'electron'
import { ErrorCodes } from '../../src/shared/errorCodes'
import { getSecurityAuditLog, setSecurityAuditRetentionDays } from '../confirmation/audit'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { makeRecordSettings, makePushExposureToolsChanged } from './ipcShared'
import { readSecurityAuditRetentionDays } from '../confirmation/policyRulesRuntime'
import { readToolsConfig } from './ipcShared'
import { revokeAllLegacyTrust, revokeLegacyTrustForCacheKey } from '../confirmation/legacyTrustRevocation'
import { shell } from 'electron'
import { getDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'

export function registerSecurityIpc(ipcMain: IpcMain, ctx: AppIpcContext): void {
const recordSettings = makeRecordSettings(ctx)
const pushExposureToolsChanged = makePushExposureToolsChanged(ctx)

  ipcMain.handle('shell:manage-trusted-commands', async (_e, payload: unknown) => {
    const { listTrustedCommands, addTrustedCommand, removeTrustedCommands, cleanExpiredTrustedCommands } =
      await import('../shell/shellCommandTrust')
    const action = payload && typeof payload === 'object' ? (payload as { action?: string }).action : ''
    try {
      if (action === 'list') {
        return { ok: true as const, commands: listTrustedCommands(ctx.db) }
      }
      if (action === 'add' && typeof (payload as { command?: string }).command === 'string') {
        addTrustedCommand(ctx.db, (payload as { command: string }).command)
        // §5.6-6：shell 信任命令新增落 settings.policy-change
        recordSettings({
          kind: 'policy-change',
          lane: 'desktop',
          key: 'shell.trustedCommands',
          before: undefined,
          after: (payload as { command: string }).command
        })
        return { ok: true as const, commands: listTrustedCommands(ctx.db) }
      }
      if (action === 'remove' && Array.isArray((payload as { ids?: string[] }).ids)) {
        const ids = (payload as { ids: string[] }).ids
        const before = listTrustedCommands(ctx.db)
        const removed = before.filter((c) => ids.includes(c.id))
        const commands = removeTrustedCommands(ctx.db, ids)
        for (const item of removed) {
          logAgentEvent('info', 'trust.remove', {
            type: 'shell_command',
            item: item.command ?? item.executable,
            timestamp: Date.now()
          })
          // §5.6-6：shell 信任命令删除落 settings.policy-change（含新旧值）
          recordSettings({
            kind: 'policy-change',
            lane: 'desktop',
            key: 'shell.trustedCommands',
            before: item.command ?? item.executable,
            after: undefined,
            reason: 'remove-trusted-command'
          })
        }
        return { ok: true as const, commands }
      }
      if (action === 'cleanExpired') {
        cleanExpiredTrustedCommands(ctx.db)
        return { ok: true as const, commands: listTrustedCommands(ctx.db) }
      }
      return { ok: false as const, error: 'invalid action' }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { ok: false as const, error: message }
    }
  })

  ipcMain.handle(
    'shell:test-executable',
    async (
      _event,
      payload: { executable?: string; argsPrefix?: string[] }
    ): Promise<{ ok: boolean; error?: string }> => {
      const { testShellExecutable } = await import('../tools/runShellExecutor')
      const exe = typeof payload.executable === 'string' ? payload.executable.trim() : ''
      if (!exe) return { ok: false, error: ErrorCodes.SHELL_EXECUTABLE_REQUIRED }
      return testShellExecutable(exe, payload.argsPrefix, ctx.getWorkDir())
    }
  )

  ipcMain.handle(
    'shell:open-output-path',
    async (_e, absPath: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const target = typeof absPath === 'string' ? absPath.trim() : ''
      if (!target) return { ok: false, error: ErrorCodes.INVALID_PATH }
      let resolvedTarget = target
      if (target.startsWith('artifact-')) {
        const artifactStem = target.slice('artifact-'.length)
        if (!/^[0-9a-f]{64}$/i.test(artifactStem)) return { ok: false, error: ErrorCodes.INVALID_PATH }
        resolvedTarget = path.join(ctx.getUserDataPath(), 'shell-output', `${artifactStem}.log`)
      }
      const artifactRoot = path.resolve(ctx.getUserDataPath(), 'shell-output')
      const resolved = path.resolve(resolvedTarget)
      if (!resolved.startsWith(`${artifactRoot}${path.sep}`)) return { ok: false, error: ErrorCodes.INVALID_PATH }
      const err = await shell.openPath(resolved)
      return err ? { ok: false, error: err } : { ok: true }
    }
  )

  ipcMain.handle(
    'shell:open-terminal',
    async (_e, payload: { cwd?: string }): Promise<{ ok: true } | { ok: false; error: string }> => {
      const cwd = typeof payload?.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : ctx.getWorkDir()
      const { openTerminalAtCwd } = await import('../browser/openTerminalAtCwd')
      return openTerminalAtCwd(cwd, ctx.getBrowserDetectContext(), { allowedWorkDir: ctx.getWorkDir() })
    }
  )

  setSecurityAuditRetentionDays(readSecurityAuditRetentionDays(ctx.db))

  const publishAuthorizationChange = (lane: 'desktop' | 'wechat' | 'feishu' | 'automation'): void => {
    getDefaultAgentRuntime().policyAuthorizationChanges.publish(lane)
  }
  const publishAffectedPolicyLanes = (rule: { match?: { lane?: readonly string[] } }): void => {
    const lanes = ['desktop', 'wechat', 'feishu', 'automation'] as const
    for (const lane of lanes) if (!rule.match?.lane?.length || rule.match.lane.includes(lane)) publishAuthorizationChange(lane)
  }

  const securityDeps = async () => {
    const runtime = await import('../confirmation/policyRulesRuntime')
    const model = await import('../confirmation/settingsSecurityModel')
    const auditMod = await import('../confirmation/audit')
    const { SqliteDecisionCache } = await import('../confirmation/sqliteDecisionCache')
    const { PolicyRuleStore } = await import('../confirmation/policyRuleStore')
    const { DEFAULT_POLICY_RULES } = await import('../../src/shared/policy/defaultRules')
    const { recordSettingsChange } = await import('../confirmation/settingsAudit')
    return { runtime, model, auditMod, SqliteDecisionCache, PolicyRuleStore, DEFAULT_POLICY_RULES, recordSettingsChange }
  }

  ipcMain.handle('security:get-settings-model', async () => {
    const { runtime, model, auditMod, SqliteDecisionCache, PolicyRuleStore, DEFAULT_POLICY_RULES } =
      await securityDeps()
    const { getDbConnection } = await import('../database')
    const conn = getDbConnection(ctx.db)
    const tools = readToolsConfig(ctx.db)
    return model.buildSettingsSecurityModel({
      packages: runtime.readPolicyPackages(ctx.db),
      policyRevisions: { desktop: runtime.readDesktopPolicyRevision(ctx.db) },
      deniedTools: tools.deniedTools,
      cache: new SqliteDecisionCache(conn).list(),
      rules: model.toRuleViews(
        DEFAULT_POLICY_RULES,
        runtime.readDesktopPolicyOverrides(ctx.db),
        runtime.readDisabledPolicyRuleIds(ctx.db)
      ),
      retentionDays: runtime.readSecurityAuditRetentionDays(ctx.db),
      haveAuditLog: auditMod.getSecurityAuditLogDir() != null
    })
  })

  ipcMain.handle(
    'security:set-policy-package',
    async (_e, payload: { lane?: unknown; package?: unknown; expectedRevision?: unknown }) => {
      const { runtime, recordSettingsChange } = await securityDeps()
      const { isPolicyPackage } = await import('../../src/shared/policy/policyPackages')
      const lane = payload?.lane
      const pkg = payload?.package
      if (lane !== 'desktop' && lane !== 'wechat' && lane !== 'feishu' && lane !== 'automation') {
        return { ok: false as const, error: 'invalid lane' }
      }
      if (!isPolicyPackage(pkg)) return { ok: false as const, error: 'invalid package' }
      // §2.1 档位可用性（B2）：本链路不提供的档位拒绝（automation 仅 standard）
      const { isPackageAvailableForLane } = await import('../../src/shared/policy/policyPackages')
      if (!isPackageAvailableForLane(lane, pkg)) {
        return { ok: false as const, error: `package ${String(pkg)} not available for lane ${lane}` }
      }
      if (lane === 'desktop') {
        if (!Number.isSafeInteger(payload?.expectedRevision) || (payload.expectedRevision as number) < 0) return { ok: false as const, error: 'POLICY_REVISION_INVALID' }
        const { getDbConnection } = await import('../database')
        const { commitDesktopPolicySnapshot, readPolicyBehaviorSnapshot } = await import('../confirmation/imPolicyStore')
        const conn = getDbConnection(ctx.db)
        let current: { revision: number; snapshot: Record<string, unknown> }
        try { current = readPolicyBehaviorSnapshot(conn, 'desktop', { supportedBehaviorVersions: ['desktop-v1'] }) }
        catch { current = { revision: 0, snapshot: { selectedPackage: 'standard', ruleOverrides: {} } } }
        const before = current.snapshot.selectedPackage ?? 'standard'
        const result = commitDesktopPolicySnapshot(conn, {
          expectedRevision: current.revision, policyBehaviorVersion: 'desktop-v1',
          snapshot: { ...current.snapshot, selectedPackage: pkg }, updatedAt: Date.now(),
          eventId: `desktop-policy:${randomUUID()}`, auditMetadata: { lane, changeKind: 'package', before, after: pkg },
          onCommitted: () => publishAuthorizationChange('desktop')
        })
        if (result.status === 'conflict') return { ok: false as const, error: 'POLICY_REVISION_CONFLICT', currentRevision: result.currentRevision }
        ctx.db.flushSave()
        await pushExposureToolsChanged('desktop')
        try { recordSettingsChange(getSecurityAuditLog(), { kind: 'policy-change', lane: 'desktop', sessionId: 'settings',
          key: 'policyPackage.desktop', before, after: pkg }) } catch { /* durable snapshot audit is authoritative */ }
        return { ok: true as const, revision: result.revision }
      }
      const packages = runtime.readPolicyPackages(ctx.db)
      const before = packages[lane]
      if (before === pkg) return { ok: true as const }
      packages[lane] = pkg
      runtime.writePolicyPackages(ctx.db, packages)
      ctx.db.flushSave()
      publishAuthorizationChange(lane)
      try { recordSettingsChange(getSecurityAuditLog(), {
        kind: 'policy-change',
        lane,
        sessionId: 'settings',
        key: `policyPackage.${lane}`,
        before,
        after: pkg
      }) } catch { /* durable snapshot audit is authoritative */ }
      if (lane !== 'automation') await pushExposureToolsChanged(lane)
      return { ok: true as const }
    }
  )

  ipcMain.handle(
    'security:set-rule-override',
    async (_e, payload: { ruleId?: unknown; action?: unknown; lane?: unknown; params?: unknown; expectedRevision?: unknown }) => {
      const { DEFAULT_POLICY_RULES, recordSettingsChange } = await securityDeps()
      const { validateRuleOverride } = await import('../../src/shared/policy/policyPackages')
      const { getDbConnection } = await import('../database')
      const { commitDesktopPolicySnapshot, readPolicyBehaviorSnapshot } = await import('../confirmation/imPolicyStore')
      const ruleId = typeof payload?.ruleId === 'string' ? payload.ruleId : ''
      const lane =
        payload?.lane === 'desktop' || payload?.lane === 'wechat' || payload?.lane === 'feishu' || payload?.lane === 'automation'
          ? payload.lane
          : undefined
      if (lane !== 'desktop') return { ok: false as const, error: 'DESKTOP_POLICY_LANE_REQUIRED' }
      if (!Number.isSafeInteger(payload?.expectedRevision) || (payload?.expectedRevision as number) < 0) {
        return { ok: false as const, error: 'POLICY_REVISION_INVALID' }
      }
      // 主进程侧强制校验：规则存在且动作在当前 lane 域内；locked 不缩减动作选项。
      const check = validateRuleOverride(DEFAULT_POLICY_RULES, ruleId, payload?.action, lane)
      if (!check.ok) return { ok: false as const, error: check.error }
      const params =
        payload?.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
          ? (payload.params as Record<string, unknown>)
          : {}
      const snapshot = (() => {
        try { return readPolicyBehaviorSnapshot(getDbConnection(ctx.db), 'desktop', { supportedBehaviorVersions: ['desktop-v1'] }) }
        catch { return { revision: 0, snapshot: { selectedPackage: 'standard', ruleOverrides: {} } } }
      })()
      const currentOverrides = snapshot.snapshot.ruleOverrides && typeof snapshot.snapshot.ruleOverrides === 'object' && !Array.isArray(snapshot.snapshot.ruleOverrides)
        ? snapshot.snapshot.ruleOverrides as Record<string, unknown> : {}
      const before = currentOverrides[ruleId] ?? check.rule.action
      const nextOverrides = { ...currentOverrides, [ruleId]: payload!.action }
      const result = commitDesktopPolicySnapshot(getDbConnection(ctx.db), {
        expectedRevision: payload!.expectedRevision as number, policyBehaviorVersion: 'desktop-v1',
        snapshot: { ...snapshot.snapshot, ruleOverrides: nextOverrides }, updatedAt: Date.now(), eventId: `desktop-policy:${randomUUID()}`,
        auditMetadata: { lane, ruleId, beforeAction: before, afterAction: payload!.action },
        onCommitted: () => publishAffectedPolicyLanes(check.rule)
      })
      if (result.status === 'conflict') return { ok: false as const, error: 'POLICY_REVISION_CONFLICT', currentRevision: result.currentRevision }
      ctx.db.flushSave()
      try { recordSettingsChange(getSecurityAuditLog(), {
        kind: 'policy-change',
        lane: 'desktop',
        sessionId: 'settings',
        key: ruleId,
        before,
        after: payload!.action
      }) } catch { /* durable snapshot audit is authoritative */ }
      for (const l of ['desktop', 'wechat', 'feishu'] as const) await pushExposureToolsChanged(l)
      return { ok: true as const }
    }
  )

  ipcMain.handle('security:remove-rule-override', async (_e, payload: { ruleId?: unknown; expectedRevision?: unknown }) => {
    const { DEFAULT_POLICY_RULES, recordSettingsChange } = await securityDeps()
    const { getDbConnection } = await import('../database')
    const { commitDesktopPolicySnapshot, readPolicyBehaviorSnapshot } = await import('../confirmation/imPolicyStore')
    const ruleId = typeof payload?.ruleId === 'string' ? payload.ruleId : ''
    const rule = DEFAULT_POLICY_RULES.find((r) => r.id === ruleId)
    if (!rule) return { ok: false as const, error: `unknown rule: ${ruleId}` }
    if (!Number.isSafeInteger(payload?.expectedRevision) || (payload.expectedRevision as number) < 0) return { ok: false as const, error: 'POLICY_REVISION_INVALID' }
    const conn = getDbConnection(ctx.db)
    let current: { revision: number; snapshot: Record<string, unknown> }
    try { current = readPolicyBehaviorSnapshot(conn, 'desktop', { supportedBehaviorVersions: ['desktop-v1'] }) }
    catch { current = { revision: 0, snapshot: { selectedPackage: 'standard', ruleOverrides: {} } } }
    if (current.revision !== payload.expectedRevision) return { ok: false as const, error: 'POLICY_REVISION_CONFLICT', currentRevision: current.revision }
    const overrides = current.snapshot.ruleOverrides && typeof current.snapshot.ruleOverrides === 'object' && !Array.isArray(current.snapshot.ruleOverrides)
      ? { ...(current.snapshot.ruleOverrides as Record<string, unknown>) } : {}
    const prev = overrides[ruleId]
    delete overrides[ruleId]
    const result = commitDesktopPolicySnapshot(conn, {
      expectedRevision: current.revision, policyBehaviorVersion: 'desktop-v1',
      snapshot: { ...current.snapshot, ruleOverrides: overrides }, updatedAt: Date.now(), eventId: `desktop-policy:${randomUUID()}`,
      auditMetadata: { lane: 'desktop', ruleId, beforeAction: prev ?? rule.action, afterAction: rule.action, reason: 'reset-to-default' },
      onCommitted: () => { if (prev !== undefined) publishAffectedPolicyLanes(rule) }
    })
    if (result.status === 'conflict') return { ok: false as const, error: 'POLICY_REVISION_CONFLICT', currentRevision: result.currentRevision }
    ctx.db.flushSave()
    if (prev !== undefined) {
      try { recordSettingsChange(getSecurityAuditLog(), {
        kind: 'policy-change',
        lane: 'desktop',
        sessionId: 'settings',
        key: ruleId,
        before: prev,
        after: rule.action,
        reason: 'reset-to-default'
      }) } catch { /* durable snapshot audit is authoritative */ }
    }
    return { ok: true as const, removed: prev !== undefined ? 1 : 0, revision: result.revision }
  })

  // Temporary compatibility shim until T8: old callers expressed disabled as
  // an explicit allow and enabled as removal of the override (default action).
  ipcMain.handle('security:set-rule-enabled', async (_e, payload: { ruleId?: unknown; enabled?: unknown }) => {
    const { DEFAULT_POLICY_RULES } = await securityDeps()
    const ruleId = typeof payload?.ruleId === 'string' ? payload.ruleId : ''
    const rule = DEFAULT_POLICY_RULES.find((candidate) => candidate.id === ruleId)
    if (!rule) return { ok: false as const, error: `unknown rule: ${ruleId}` }
    const { getDbConnection } = await import('../database')
    const { commitDesktopPolicySnapshot, readPolicyBehaviorSnapshot } = await import('../confirmation/imPolicyStore')
    const conn = getDbConnection(ctx.db)
    let current: { revision: number; snapshot: Record<string, unknown> }
    try { current = readPolicyBehaviorSnapshot(conn, 'desktop', { supportedBehaviorVersions: ['desktop-v1'] }) }
    catch { current = { revision: 0, snapshot: { selectedPackage: 'standard', ruleOverrides: {} } } }
    const overrides = current.snapshot.ruleOverrides && typeof current.snapshot.ruleOverrides === 'object' && !Array.isArray(current.snapshot.ruleOverrides)
      ? { ...current.snapshot.ruleOverrides as Record<string, unknown> } : {}
    const before = overrides[ruleId] ?? rule.action
    const enabled = payload?.enabled !== false
    if (enabled) delete overrides[ruleId]
    else overrides[ruleId] = 'allow'
    const result = commitDesktopPolicySnapshot(conn, {
      expectedRevision: current.revision, policyBehaviorVersion: 'desktop-v1',
      snapshot: { ...current.snapshot, ruleOverrides: overrides }, updatedAt: Date.now(),
      eventId: `desktop-policy-legacy-toggle:${randomUUID()}`,
      auditMetadata: { lane: 'desktop', changeKind: 'legacy-rule-enabled', ruleId, before, after: enabled ? rule.action : 'allow' },
      onCommitted: () => publishAuthorizationChange('desktop')
    })
    if (result.status === 'conflict') return { ok: false as const, error: 'POLICY_REVISION_CONFLICT' }
    ctx.db.flushSave()
    await pushExposureToolsChanged('desktop')
    return { ok: true as const }
  })

  ipcMain.handle('security:list-cache', async () => {
    const { SqliteDecisionCache } = await securityDeps()
    const { getDbConnection } = await import('../database')
    return new SqliteDecisionCache(getDbConnection(ctx.db)).list()
  })

  ipcMain.handle('security:clear-cache', async (_e, payload: { key?: unknown }) => {
    const { SqliteDecisionCache } = await securityDeps()
    const { getDbConnection } = await import('../database')
    const { canonicalKeyJson } = await import('../confirmation/sqliteDecisionCache')
    const cache = new SqliteDecisionCache(getDbConnection(ctx.db))
    const audit = getSecurityAuditLog()
    // 清除即"下次再问"（§7 第 4 区）；单条/全部均落 cache.clear 审计
    const key = payload?.key && typeof payload.key === 'object' ? (payload.key as never) : null
    const cleared = key ? cache.clear(key) : cache.clearAll()
    // B6/B7：decision_cache 与旧信任存储（shell 信任命令 / 浏览器域名信任）双源生效，
    // 清除必须联动撤销旧存储，否则信任永久生效、不可见、不可撤销（fail-open）。
    const legacyRevoked = key
      ? revokeLegacyTrustForCacheKey(ctx.db, key)
      : revokeAllLegacyTrust(ctx.db)
    ctx.db.flushSave()
    audit.record({
      ts: Date.now(),
      event: 'cache.clear',
      lane: 'desktop',
      sessionId: 'settings',
      cacheKey: key ? canonicalKeyJson(key) : '*',
      reason: key ? undefined : 'clear-all',
      actor: 'user'
    })
    return { ok: true as const, cleared, legacyRevoked }
  })

  ipcMain.handle('security:query-audit', async (_e, payload: unknown) => {
    const { querySecurityAuditLog } = await import('../confirmation/securityAuditReader')
    const { getSecurityAuditLogDir } = await import('../confirmation/audit')
    const dir = getSecurityAuditLogDir()
    if (!dir) return []
    const q = (payload && typeof payload === 'object' ? payload : {}) as {
      since?: number
      until?: number
      lane?: 'desktop' | 'wechat' | 'feishu' | 'automation'
      event?: string
      toolName?: string
      limit?: number
    }
    return querySecurityAuditLog(dir, q)
  })

  ipcMain.handle('security:get-audit-retention', async () => {
    const { runtime } = await securityDeps()
    return runtime.readSecurityAuditRetentionDays(ctx.db)
  })

  ipcMain.handle('security:set-audit-retention', async (_e, payload: { days?: unknown }) => {
    const { runtime, auditMod, recordSettingsChange } = await securityDeps()
    const days = typeof payload?.days === 'number' ? Math.floor(payload.days) : Number.NaN
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      return { ok: false as const, error: 'invalid retention days' }
    }
    const before = runtime.readSecurityAuditRetentionDays(ctx.db)
    runtime.writeSecurityAuditRetentionDays(ctx.db, days)
    ctx.db.flushSave()
    auditMod.setSecurityAuditRetentionDays(days)
    if (before !== days) {
      recordSettingsChange(getSecurityAuditLog(), {
        kind: 'policy-change',
        lane: 'desktop',
        sessionId: 'settings',
        key: 'securityAudit.retentionDays',
        before,
        after: days
      })
    }
    return { ok: true as const }
  })
}
