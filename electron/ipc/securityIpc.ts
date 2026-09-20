// Phase 2 拆分:本文件自 appIpc.ts 纯移动而来,通道名与行为不变(driver-authority-refactor Phase 2)。
import path from 'path'
import type { AppIpcContext } from '../appIpc'
import type { IpcMain } from 'electron'
import { ErrorCodes } from '../../src/shared/errorCodes'
import { getSecurityAuditLog, setSecurityAuditRetentionDays } from '../confirmation/audit'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { makeRecordSettings, makePushExposureToolsChanged } from './ipcShared'
import { readSecurityAuditRetentionDays } from '../confirmation/policyRulesRuntime'
import { readToolsConfig } from './ipcShared'
import { recordSettingsChange } from '../confirmation/settingsAudit'
import { revokeAllLegacyTrust, revokeLegacyTrustForCacheKey } from '../confirmation/legacyTrustRevocation'
import { shell } from 'electron'

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
      event,
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
      deniedTools: tools.deniedTools,
      cache: new SqliteDecisionCache(conn).list(),
      rules: model.toRuleViews(
        DEFAULT_POLICY_RULES,
        new PolicyRuleStore(conn).listOverrides(),
        runtime.readDisabledPolicyRuleIds(ctx.db)
      ),
      retentionDays: runtime.readSecurityAuditRetentionDays(ctx.db),
      haveAuditLog: auditMod.getSecurityAuditLogDir() != null
    })
  })

  ipcMain.handle(
    'security:set-policy-package',
    async (_e, payload: { lane?: unknown; package?: unknown }) => {
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
      const packages = runtime.readPolicyPackages(ctx.db)
      const before = packages[lane]
      if (before === pkg) return { ok: true as const }
      packages[lane] = pkg
      runtime.writePolicyPackages(ctx.db, packages)
      ctx.db.flushSave()
      recordSettingsChange(getSecurityAuditLog(), {
        kind: 'policy-change',
        lane,
        sessionId: 'settings',
        key: `policyPackage.${lane}`,
        before,
        after: pkg
      })
      if (lane !== 'automation') await pushExposureToolsChanged(lane)
      return { ok: true as const }
    }
  )

  ipcMain.handle(
    'security:set-rule-override',
    async (_e, payload: { ruleId?: unknown; action?: unknown; lane?: unknown; params?: unknown }) => {
      const { PolicyRuleStore, DEFAULT_POLICY_RULES, recordSettingsChange } = await securityDeps()
      const { validateRuleOverride } = await import('../../src/shared/policy/policyPackages')
      const { getDbConnection } = await import('../database')
      const ruleId = typeof payload?.ruleId === 'string' ? payload.ruleId : ''
      const lane =
        payload?.lane === 'desktop' || payload?.lane === 'wechat' || payload?.lane === 'feishu' || payload?.lane === 'automation'
          ? payload.lane
          : undefined
      // 主进程侧强制校验：规则必须存在、非 locked、动作域按链路（B2：desktop 4 态 / 远程 3 态）
      const check = validateRuleOverride(DEFAULT_POLICY_RULES, ruleId, payload?.action, lane)
      if (!check.ok) return { ok: false as const, error: check.error }
      const params =
        payload?.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
          ? (payload.params as Record<string, unknown>)
          : {}
      const store = new PolicyRuleStore(getDbConnection(ctx.db))
      const prev = store.getOverride(ruleId)
      const before = prev?.action ?? check.rule.action
      store.setOverride({ ruleId, action: payload!.action as never, params })
      ctx.db.flushSave()
      recordSettingsChange(getSecurityAuditLog(), {
        kind: 'policy-change',
        lane: 'desktop',
        sessionId: 'settings',
        key: ruleId,
        before,
        after: payload!.action
      })
      for (const l of ['desktop', 'wechat', 'feishu'] as const) await pushExposureToolsChanged(l)
      return { ok: true as const }
    }
  )

  ipcMain.handle('security:remove-rule-override', async (_e, payload: { ruleId?: unknown }) => {
    const { PolicyRuleStore, DEFAULT_POLICY_RULES, recordSettingsChange } = await securityDeps()
    const { getDbConnection } = await import('../database')
    const ruleId = typeof payload?.ruleId === 'string' ? payload.ruleId : ''
    const rule = DEFAULT_POLICY_RULES.find((r) => r.id === ruleId)
    if (!rule) return { ok: false as const, error: `unknown rule: ${ruleId}` }
    const store = new PolicyRuleStore(getDbConnection(ctx.db))
    const prev = store.getOverride(ruleId)
    const removed = store.removeOverride(ruleId)
    ctx.db.flushSave()
    if (removed > 0) {
      recordSettingsChange(getSecurityAuditLog(), {
        kind: 'policy-change',
        lane: 'desktop',
        sessionId: 'settings',
        key: ruleId,
        before: prev?.action,
        after: rule.action,
        reason: 'reset-to-default'
      })
    }
    return { ok: true as const, removed }
  })

  // 系统保护（禁止类）规则「启用/不启用」开关：启用=在策略链中生效（可作第 1 步硬拒），
  // 不启用=从生效规则集剔除（不再硬拒，交还常规规则链）。仅 locked + deny 的保护规则可切换；
  // fail-closed 的 locked ask 规则（lark-high-impact-ask 等）不可禁用——禁用等价调松兜底。

  ipcMain.handle(
    'security:set-rule-enabled',
    async (_e, payload: { ruleId?: unknown; enabled?: unknown }) => {
      const { runtime, DEFAULT_POLICY_RULES, recordSettingsChange } = await securityDeps()
      const ruleId = typeof payload?.ruleId === 'string' ? payload.ruleId : ''
      const rule = DEFAULT_POLICY_RULES.find((r) => r.id === ruleId)
      if (!rule) return { ok: false as const, error: `unknown rule: ${ruleId}` }
      if (!rule.locked || rule.action !== 'deny') {
        return { ok: false as const, error: `rule is not a protection rule: ${ruleId}` }
      }
      const enabled = payload?.enabled !== false
      const disabledIds = runtime.readDisabledPolicyRuleIds(ctx.db)
      const before = !disabledIds.includes(ruleId)
      const nextDisabled = enabled
        ? disabledIds.filter((id) => id !== ruleId)
        : Array.from(new Set([...disabledIds, ruleId]))
      runtime.writeDisabledPolicyRuleIds(ctx.db, nextDisabled)
      ctx.db.flushSave()
      recordSettingsChange(getSecurityAuditLog(), {
        kind: 'policy-change',
        lane: (rule.match?.lane?.[0] as 'desktop' | 'wechat' | 'feishu' | 'automation') ?? 'desktop',
        sessionId: 'settings',
        key: `policyRuleEnabled.${ruleId}`,
        before,
        after: enabled
      })
      for (const l of ['desktop', 'wechat', 'feishu'] as const) await pushExposureToolsChanged(l)
      return { ok: true as const }
    }
  )

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
