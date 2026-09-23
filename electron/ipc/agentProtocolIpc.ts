// Phase 2 拆分:本文件自 appIpc.ts 纯移动而来,通道名与行为不变(driver-authority-refactor Phase 2)。
import fs from 'fs/promises'
import path from 'path'
import type { AppIpcContext } from '../appIpc'
import type { IpcMain } from 'electron'
import { AUTO_CONTRACT } from '../processOutput/contracts'
import { AgentLogEventName, AgentLogFields } from '../agentLogger/types'
import { CONFIG_KEYS, readSkillsConfig, readWikiConfig, scheduleBackup, flushBackup, backupAfterMessagePatch, readExposureInputsFromDb } from './ipcShared'
import { ChatImageAttachment } from '../../src/shared/domainTypes'
import { ErrorCodes } from '../../src/shared/errorCodes'
import { Message, ModelEntry, SessionSkillsState, SkillDefinition, SkippedCandidate, SkillRouteRecentMessage, SkillRouteResult } from '../../src/shared/domainTypes'
import { OutboundSubmitIntent } from '../../src/shared/outboundProtocol'
import { TurnExecutePayload } from '../../src/shared/api'
import { TurnIntent } from '../../src/shared/assistantFactAggregator'
import { TurnRuntime as TurnRuntimeImpl } from '../turnRuntime'
import { TurnStarted } from '../../src/shared/turnCoordinator'
import { getDbConnection } from '../database'
import { WikiStatus } from '../../src/shared/domainTypes'
import { app, shell } from 'electron'
import { appendMessage, createSession, deleteQueuedUserMessage, enqueueQueuedUserMessage, getApiContextBaseline, getChatMessagePage, getContextHistorySummaryBaseline, getSearchCorpusPage, getConfigValue, getMessageSequence, getMessage, getMessages, getRecentTurnRoutingMessages, hasVisionInTurnRoutingContext, getNextQueuedMessage, getSession, getTurnByRequestId, getPersistedTurn, setPersistedTurnExecutionConfig, failConfiguringTurn, listPersistedTurns, listTurnErrorsByAssistantMessageIds, resolveRetryContext, setConfigValue, updateMessageContent, updateSession } from '../database'
import { canonicalQueueInput } from '../../src/shared/queueInputFingerprint'
import { clampMaxParallelChatSessions } from '../../src/shared/chatParallelConfig'
import { classifyWikiPath } from '../wiki/wikiPaths'
import { createAnthropicClient } from '../anthropicClientFactory'
import { createOutboundAcceptor, createOutboundDrainer, computeContextPressureWarnings } from '../outbound/outboundAcceptor'
import { createSkillHintSystemMessage } from '../../src/shared/skillHintRecords'
import { createSkillManager } from '../skills/skillManager'
import { createTurnCoordinatorStorage } from '../turnCoordinatorStorage'
import { decodeChildOutput } from '../processOutput/decodeChildOutput'
import { discardStagedImage, readStagedImage, stageChatImage } from '../chatAttachmentManager'
import { ensureSkillsDirs, getProjectSkillsDir, getUserSkillsDir } from '../skills/skillPaths'
import { existsSync } from 'fs'
import { getCachedMemoryState, loadProjectMemory, writeProjectMemory, generateProjectMemory } from '../projectMemory'
import { getSecurityAuditLog } from '../confirmation/audit'
import { getWikiStatus } from '../wiki/wikiStatus'
import { importRawFromWorkDir, wikiImportFileTreeChange } from '../wiki/wikiImport'
import { initWikiStructure, readWikiSchema } from '../wiki/wikiInit'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { makeRecordTrustToCache } from './ipcShared'
import { normalizeSessionSkillsState } from '../../src/shared/domainTypes'
import { normalizeTurnExecutionConfig } from '../../src/shared/turnCoordinator'
import { notifyFileTreeChanged } from '../fileTreeSyncNotify'
import { randomUUID } from 'node:crypto'
import { readActiveLlmServiceId, readLlmServices, resolveFastPreferredModelName, resolveLanguagePreferredModelName, resolveLlmCredentialsForModel } from '../llmServiceResolver'
import { readBrowserConfigFromDb, persistBrowserConfig } from '../browser/browserConfigDb'
import { recordUserAnswerFromMemoryTiers, clearSystemManagedCacheEntry, readSystemManagedCacheEntry, restoreSystemManagedCacheEntry } from '../confirmation/decisionCacheWriter'
import { canonicalKeyJson } from '../confirmation/sqliteDecisionCache'
import { revokeLegacyTrustForCacheKey } from '../confirmation/legacyTrustRevocation'
import { resolveSafePath } from '../pathSecurity'
import { resolveTrustedTurnExecutionConfig } from '../turnExecutionConfig'
import { scanSkillsWithSkipped } from '../skills/skillScanner'
import { spawn } from 'child_process'
import { submitToolConfirmResponse, reserveToolConfirmResponse, restoreReservedToolConfirm, isToolConfirmCommitAllowed, signalToolCancel, isPendingMemoryTier, getPendingMemoryTiers, isPendingConfirm, getPendingConfirmToolName, getPendingConfirmSessionId, getPendingConfirmGeneration, getPendingConfirmRevision, getPendingMcpTrust, isPendingTrust } from '../toolConfirmRegistry'
import { toConfirmationSnapshot, turnToDisplay } from '../../src/shared/turnDisplayProtocol'
import { getCallAdmissionGate } from '../runtime/callAdmissionGate'
import { cancelClaudeAdmission } from '../claudeStreamHandlers'
import { reserveConfirmationSubmission, commitConfirmationSubmissionWithWork, markConfirmationSubmissionReconciling, reconcileConfirmationSubmission, reconcileConfirmationSubmissions, ConfirmationCommitRolledBackError, ConfirmationCommitUnknownError } from '../confirmation/persistentConfirmationCommit'
import { forgetMcpSessionTrust, isMcpSessionTrusted, rememberMcpSessionTrust } from '../mcp/mcpSessionTrust'

/** 将持久 receipt 对账结果回接到仍在主进程等待的桌面确认项。 */
function settleReconciledDesktopConfirm(result: { submissionId: string; outcome: 'committed' | 'rolled_back' }): void {
  // IM receipt 不使用 desktop toolConfirmRegistry；其 pending 由各自 ImChannel 管理。
  if (result.submissionId.startsWith('im:')) return
  const separator = result.submissionId.lastIndexOf(':')
  if (separator <= 0 || separator === result.submissionId.length - 1) return
  const requestId = result.submissionId.slice(0, separator)
  const toolUseId = result.submissionId.slice(separator + 1)
  if (result.outcome === 'committed') submitToolConfirmResponse(requestId, toolUseId, true)
  else restoreReservedToolConfirm(requestId, toolUseId)
}

export function registerAgentIpc(ipcMain: IpcMain, ctx: AppIpcContext): void {
const recordTrustToCache = makeRecordTrustToCache(ctx)

  // 启动恢复器：进程崩溃/重启后仍能收敛上次 COMMIT 未知的 receipt，
  // 且不会把已确认的 waiter 永久留在 committing。
  try { reconcileConfirmationSubmissions(ctx.db, settleReconciledDesktopConfirm) } catch { /* 下次启动继续对账 */ }

  const turnRuntime = ctx.turnRuntime ?? new TurnRuntimeImpl({ storage: createTurnCoordinatorStorage(ctx.db), deps: { now: Date.now, id: randomUUID } })

  const turnCoordinator = turnRuntime.coordinator

  if (ctx.turnRuntime && typeof listPersistedTurns === 'function') {
    for (const state of ['configuring', 'prepared', 'executing', 'waiting-confirm']) {
      for (const persisted of listPersistedTurns(ctx.db, state)) {
        const assistant = getMessage(ctx.db, persisted.assistantMessageId)
        if (assistant) turnCoordinator.restoreTurn(persisted, assistant)
      }
    }
  }

  if (ctx.turnRuntime) turnCoordinator.recover()

  const skillManager = createSkillManager({
    getUserDataPath: ctx.getUserDataPath,
    getWorkDir: ctx.getWorkDir,
    getSkillsConfig: () => readSkillsConfig(ctx.db),
    getWikiConfig: () => readWikiConfig(ctx.db)
  })

  let activeSkillInstallAbort: AbortController | null = null

  const configuringTurns = new Map<string, Promise<unknown>>()

  const configuringTurnsById = new Map<string, Promise<unknown>>()

  const configuringAbortControllers = new Map<string, AbortController>()

  ipcMain.handle(
    'tool:confirm-response',
    async (
      event,
      payload: {
        requestId: string
        toolUseId: string
        approved: boolean
        trustCommand?: string
        trustDomain?: string
        trustActDomain?: string
        sessionId?: string
        trustMcpServerId?: string
        trustMcpToolName?: string
        memoryTier?: import('../../src/shared/confirmation/types').CacheKey
        memoryTierOptionId?: number
      }
    ): Promise<import('../toolConfirmRegistry').ToolConfirmSubmitResult> => {
      // H1：信任写入必须与 pending 确认挂钩——agent 裁决路径（AgentChannel）不登记 waiter，
      // 其残留确认卡片上的「信任并允许」点击在此被拒绝，不得形成与裁决结果相悖的持久授权。
      const pendingConfirm = isPendingConfirm(payload.requestId, payload.toolUseId)
      if (!pendingConfirm) {
        logAgentEvent('warn', 'tool.confirm.trust_rejected_no_pending', {
          requestId: payload.requestId,
          toolUseId: payload.toolUseId,
          sessionId: payload.sessionId,
          timestamp: Date.now()
        })
        return submitToolConfirmResponse(payload.requestId, payload.toolUseId, payload.approved)
      }
      const trustedSessionId = getPendingConfirmSessionId(payload.requestId, payload.toolUseId)
      if (!trustedSessionId || (payload.sessionId && trustedSessionId !== payload.sessionId)) {
        return { accepted: false, outcome: 'missing' }
      }
      const ownerSessionId = trustedSessionId
      const ownerGeneration = getPendingConfirmGeneration(payload.requestId, payload.toolUseId)
      const ownerRevision = getPendingConfirmRevision(payload.requestId, payload.toolUseId)
      if (!ownerGeneration || !ownerRevision) return { accepted: false, outcome: 'missing' }
      // 先一次性消费 pending，再进行任何异步导入/持久化；避免确认超时或被并发响应消费后仍落信任。
      const pendingMemoryTiers = getPendingMemoryTiers(payload.requestId, payload.toolUseId)
      const pendingToolName = getPendingConfirmToolName(payload.requestId, payload.toolUseId)
      const commandTrustAllowed = !payload.trustCommand?.trim() || !pendingToolName || (pendingToolName === 'run_shell' && isPendingTrust(payload.requestId, payload.toolUseId, 'command', payload.trustCommand.trim()))
      const domainTrustAllowed = !payload.trustDomain?.trim() || !pendingToolName || (pendingToolName === 'browser' && isPendingTrust(payload.requestId, payload.toolUseId, 'domain', payload.trustDomain.trim()))
      const actDomainTrustAllowed = !payload.trustActDomain?.trim() || !pendingToolName || (pendingToolName === 'browser' && isPendingTrust(payload.requestId, payload.toolUseId, 'act-domain', payload.trustActDomain.trim()))
      // 组合响应必须先完成整体验证，再允许任何一项信任/记忆写入。
      // 否则先写入的 trustCommand 会在后续非法 trustDomain/MCP 字段拒绝时泄漏。
      const mcpTrustRequested = Boolean(payload.trustMcpServerId && payload.trustMcpToolName)
      const pendingMcpTrust = getPendingMcpTrust(payload.requestId, payload.toolUseId)
      const mcpTrustAllowed = !mcpTrustRequested || Boolean(
        pendingMcpTrust &&
        isPendingTrust(payload.requestId, payload.toolUseId, 'mcp', payload.trustMcpServerId!, payload.trustMcpToolName!)
      )
      const memoryTierRequested = payload.approved && (payload.memoryTierOptionId !== undefined || payload.memoryTier !== undefined)
      const memoryTierAllowed = !memoryTierRequested || Boolean(
        (payload.memoryTierOptionId !== undefined
          ? pendingMemoryTiers?.[payload.memoryTierOptionId - 1]?.key
          : payload.memoryTier) &&
        pendingMemoryTiers?.some((tier) => JSON.stringify(tier.key) === JSON.stringify(
          payload.memoryTierOptionId !== undefined
            ? pendingMemoryTiers?.[payload.memoryTierOptionId - 1]?.key
            : payload.memoryTier
        ))
      )
      if (payload.approved && (!commandTrustAllowed || !domainTrustAllowed || !actDomainTrustAllowed || !mcpTrustAllowed || !memoryTierAllowed)) {
        return submitToolConfirmResponse(payload.requestId, payload.toolUseId, false)
      }
      if (!reserveToolConfirmResponse(payload.requestId, payload.toolUseId)) {
        return { accepted: false, outcome: 'missing' }
      }
      const writtenTrustKeys: import('../../src/shared/confirmation/types').CacheKey[] = []
      const writtenCacheKeys: import('../../src/shared/confirmation/types').CacheKey[] = []
      const cacheSnapshots = new Map<string, import('../../src/shared/confirmation/types').DecisionCacheEntry | null>()
      const deferredTrustAudits: import('../../src/shared/confirmation/types').SecurityAuditEvent[] = []
      const transactionTrustAudit = { record: (event: import('../../src/shared/confirmation/types').SecurityAuditEvent) => deferredTrustAudits.push(event) }
      const flushTrustAudits = () => {
        for (const event of deferredTrustAudits.splice(0)) getSecurityAuditLog().record(event)
      }
      const submissionId = `${payload.requestId}:${payload.toolUseId}`
      const submissionPlan = {
        submissionId,
        confirmId: payload.toolUseId,
        sessionId: ownerSessionId,
        ownerId: ownerSessionId,
        generation: ownerGeneration,
        revision: ownerRevision,
        action: payload.approved ? 'approved' as const : 'denied' as const,
        memory: payload.memoryTier || payload.memoryTierOptionId !== undefined ? 'written' as const : 'none' as const
      }
      // sessionId 是响应中的可选回显字段；ownerSessionId 已从 pending waiter 校验取得，
      // 不能因为 UI 省略该字段而静默跳过本次 MCP 会话信任写入。
      const mcpTrustKey = mcpTrustRequested && pendingMcpTrust
        ? { sessionId: ownerSessionId, serverId: pendingMcpTrust.serverId, toolName: pendingMcpTrust.toolName }
        : undefined
      let existingSubmission: ReturnType<typeof reserveConfirmationSubmission>
      try {
        existingSubmission = reserveConfirmationSubmission(ctx.db, submissionPlan)
      } catch (error) {
        if (error instanceof ConfirmationCommitUnknownError) {
          try { markConfirmationSubmissionReconciling(ctx.db, submissionId, submissionPlan) } catch { /* 保留 committing，等待下次对账 */ }
          try {
            const result = reconcileConfirmationSubmission(ctx.db, submissionId)
            if (result?.outcome === 'committed') submitToolConfirmResponse(payload.requestId, payload.toolUseId, payload.approved)
            else if (result?.outcome === 'rolled_back') restoreReservedToolConfirm(payload.requestId, payload.toolUseId)
          } catch { /* 下次启动继续对账 */ }
        } else restoreReservedToolConfirm(payload.requestId, payload.toolUseId)
        throw error
      }
      if (existingSubmission?.kind === 'committed') {
        // 相同 submissionId 若已 committed，协议字段已在 reserve 阶段校验一致；
        // 仍须结算当前 waiter，且回放原请求的 action（而非无条件 approved）。
        const replayApproved = payload.approved
        submitToolConfirmResponse(payload.requestId, payload.toolUseId, replayApproved)
        return { accepted: true, outcome: replayApproved ? 'approved' : 'rejected' }
      }
      if (existingSubmission?.kind === 'not-committed') {
        restoreReservedToolConfirm(payload.requestId, payload.toolUseId)
        return { accepted: false, outcome: 'missing' }
      }
      const snapshotCache = (key: import('../../src/shared/confirmation/types').CacheKey) => {
        const id = canonicalKeyJson(key)
        if (!cacheSnapshots.has(id)) {
          try { cacheSnapshots.set(id, readSystemManagedCacheEntry({ db: ctx.db, key, lane: 'desktop' })) } catch { cacheSnapshots.set(id, null) }
        }
      }
      try {
      // 所有动态模块在事务前完成加载；事务内不得跨 await 持有连接，避免卷入其他会话写入。
      const shellTrustModule = payload.approved && payload.trustCommand?.trim()
        ? await import('../shell/shellCommandTrust')
        : undefined
      const browserTrustModule = payload.approved && (payload.trustDomain?.trim() || payload.trustActDomain?.trim())
        ? await import('../browser/browserDomainTrust')
        : undefined
      const transactionResult = commitConfirmationSubmissionWithWork(ctx.db, submissionPlan, () => {
      // 先解析并提交记忆档位；后续信任写入失败时它也会走同一补偿快照。
      if (payload.approved && payload.memoryTierOptionId !== undefined) {
        const tier = pendingMemoryTiers?.[payload.memoryTierOptionId - 1]
        if (tier) payload.memoryTier = tier.key
      }
      if (payload.approved && payload.memoryTier && pendingMemoryTiers.some((tier) => JSON.stringify(tier.key) === JSON.stringify(payload.memoryTier))) {
        if (!isToolConfirmCommitAllowed(payload.requestId, payload.toolUseId)) throw new Error('confirmation-missing')
        snapshotCache(payload.memoryTier)
        recordUserAnswerFromMemoryTiers({
          db: ctx.db,
          audit: transactionTrustAudit,
          lane: 'desktop',
          sessionId: ownerSessionId,
          key: payload.memoryTier,
          memoryTiers: pendingMemoryTiers,
          answererKind: 'user',
          source: 'user-confirm'
        })
        writtenCacheKeys.push(payload.memoryTier)
      }
      const trustAllowed = (kind: 'command' | 'domain' | 'act-domain' | 'mcp') => {
        if (kind === 'command') return true
        if (kind === 'domain' || kind === 'act-domain') return true
        return true
      }
      if (payload.approved && pendingConfirm && payload.trustCommand?.trim()) {
        if (!isToolConfirmCommitAllowed(payload.requestId, payload.toolUseId)) throw new Error('confirmation-missing')
        if (!commandTrustAllowed) throw new Error('confirmation-missing')
        const { addTrustedCommand, listTrustedCommands } = shellTrustModule!
        if (!isToolConfirmCommitAllowed(payload.requestId, payload.toolUseId)) throw new Error('confirmation-missing')
        const beforeTrustedIds = new Set((typeof listTrustedCommands === 'function' ? listTrustedCommands(ctx.db) : []).map((entry) => entry.id))
        let added: ReturnType<typeof addTrustedCommand> = null
        added = addTrustedCommand(ctx.db, payload.trustCommand!.trim(), { source: 'desktop' })
        if (added?.executable) {
          const shellVerb = JSON.stringify([added.executable, ...(added.fixedArgvPrefix ?? [])])
          snapshotCache({ kind: 'shell-command', verb: shellVerb, level: 'exact' })
          recordTrustToCache(
            { kind: 'shell-command', verb: shellVerb, level: 'exact' },
            ownerSessionId,
            'persistent',
            transactionTrustAudit
          )
          writtenCacheKeys.push({ kind: 'shell-command', verb: shellVerb, level: 'exact' })
          if (!beforeTrustedIds.has(added.id)) writtenTrustKeys.push({ kind: 'shell-command', verb: shellVerb, level: 'exact' })
        }
      }
      if (payload.approved && pendingConfirm && payload.trustDomain?.trim()) {
        if (!isToolConfirmCommitAllowed(payload.requestId, payload.toolUseId)) throw new Error('confirmation-missing')
        if (!domainTrustAllowed) throw new Error('confirmation-missing')
        const { addTrustedDomain } = browserTrustModule!
        if (!isToolConfirmCommitAllowed(payload.requestId, payload.toolUseId)) throw new Error('confirmation-missing')
        const browser = readBrowserConfigFromDb(ctx.db)
        const existed = browser.trustedDomains.some((domain) => domain.toLowerCase() === payload.trustDomain!.trim().toLowerCase())
        const next = addTrustedDomain(browser, payload.trustDomain!.trim())
        persistBrowserConfig(ctx.db, next)
        snapshotCache({ kind: 'domain', domain: payload.trustDomain!.trim(), level: 'domain-any-action' })
        recordTrustToCache({ kind: 'domain', domain: payload.trustDomain!.trim(), level: 'domain-any-action' }, ownerSessionId, 'persistent', transactionTrustAudit)
        writtenCacheKeys.push({ kind: 'domain', domain: payload.trustDomain!.trim(), level: 'domain-any-action' })
        if (!existed) writtenTrustKeys.push({ kind: 'domain', domain: payload.trustDomain!.trim(), level: 'domain-any-action' })
        // 双写 navigate 档（domain-any-action）缓存键，供执行链路缓存命中
      }
      if (payload.approved && pendingConfirm && payload.trustActDomain?.trim()) {
        if (!isToolConfirmCommitAllowed(payload.requestId, payload.toolUseId)) throw new Error('confirmation-missing')
        if (!actDomainTrustAllowed) throw new Error('confirmation-missing')
        const { addTrustedActDomain } = browserTrustModule!
        if (!isToolConfirmCommitAllowed(payload.requestId, payload.toolUseId)) throw new Error('confirmation-missing')
        const browser = readBrowserConfigFromDb(ctx.db)
        const existed = browser.actTrustedDomains.some((domain) => domain.toLowerCase() === payload.trustActDomain!.trim().toLowerCase())
        const next = addTrustedActDomain(browser, payload.trustActDomain!.trim())
        persistBrowserConfig(ctx.db, next)
        snapshotCache({ kind: 'domain', domain: payload.trustActDomain!.trim(), level: 'domain+action' })
        recordTrustToCache({ kind: 'domain', domain: payload.trustActDomain!.trim(), level: 'domain+action' }, ownerSessionId, 'persistent', transactionTrustAudit)
        writtenCacheKeys.push({ kind: 'domain', domain: payload.trustActDomain!.trim(), level: 'domain+action' })
        if (!existed) writtenTrustKeys.push({ kind: 'domain', domain: payload.trustActDomain!.trim(), level: 'domain+action' })
        // 双写 act 档（domain+action）缓存键，与 navigate 档隔离
      }
      if (!isToolConfirmCommitAllowed(payload.requestId, payload.toolUseId)) throw new Error('confirmation-missing')
      return undefined
      }, `confirm:${submissionId}`, 1, () => {
        if (!isToolConfirmCommitAllowed(payload.requestId, payload.toolUseId)) throw new Error('confirmation-missing')
      })
      if (transactionResult.kind !== 'committed') throw new Error('confirmation-commit-failed')
      flushTrustAudits()
      const mcpTrustAlreadyPresent = mcpTrustKey
        ? isMcpSessionTrusted(mcpTrustKey.sessionId, mcpTrustKey.serverId, mcpTrustKey.toolName)
        : false
      if (payload.approved && mcpTrustKey && !mcpTrustAlreadyPresent) rememberMcpSessionTrust(mcpTrustKey.sessionId, mcpTrustKey.serverId, mcpTrustKey.toolName)
      const response = submitToolConfirmResponse(payload.requestId, payload.toolUseId, payload.approved)
      if (mcpTrustKey && !mcpTrustAlreadyPresent && !response.accepted) forgetMcpSessionTrust(mcpTrustKey.sessionId, mcpTrustKey.serverId, mcpTrustKey.toolName)
      return response
      } catch (error) {
        const rolledBackBeforeCommit = error instanceof ConfirmationCommitRolledBackError
        if (!rolledBackBeforeCommit) {
          try { markConfirmationSubmissionReconciling(ctx.db, submissionId, submissionPlan) } catch { /* receipt remains unknown and fail-closed */ }
          try {
            const result = reconcileConfirmationSubmission(ctx.db, submissionId)
            if (result?.outcome === 'committed') submitToolConfirmResponse(payload.requestId, payload.toolUseId, payload.approved)
            else if (result?.outcome === 'rolled_back') restoreReservedToolConfirm(payload.requestId, payload.toolUseId)
          } catch { /* 数据库仍不可用时由启动恢复器继续处理 */ }
        }
        if (rolledBackBeforeCommit) restoreReservedToolConfirm(payload.requestId, payload.toolUseId)
        const connection = typeof getDbConnection === 'function' ? getDbConnection(ctx.db) as unknown as { exec?: unknown } : undefined
        // 真实 SQLite 已由 commitConfirmationSubmissionWithWork 回滚；不得再用补偿删除可能早已存在的授权。
        // 只有无数据库的兼容适配器才使用旧的尽力补偿路径。
        if (typeof connection?.exec !== 'function') {
          for (const key of writtenTrustKeys) {
            try { revokeLegacyTrustForCacheKey(ctx.db, key) } catch { /* fail closed */ }
          }
          for (const key of writtenCacheKeys) {
            try { const id = canonicalKeyJson(key); restoreSystemManagedCacheEntry({ db: ctx.db, key, lane: 'desktop', entry: cacheSnapshots.get(id) ?? null }) } catch { /* fail closed */ }
          }
        }
        logAgentEvent('error', 'tool.confirm.trust_rejected_no_pending', {
          requestId: payload.requestId,
          toolUseId: payload.toolUseId,
          error: error instanceof Error ? error.message : String(error),
          timestamp: Date.now()
        })
        return { accepted: false, outcome: 'missing' }
      }
    }
  )

  ipcMain.handle('tool:cancel', async (_e, payload: { requestId: string; toolUseId: string }): Promise<void> => {
    signalToolCancel(payload.requestId, payload.toolUseId)
  })

  ipcMain.handle(
    'tool:test-interpreter',
    async (_e, payload: { path: string }): Promise<{ ok: true; version: string } | { ok: false; error: string }> => {
      const py = typeof payload.path === 'string' && payload.path.trim() ? payload.path.trim() : 'python'
      return await new Promise((resolve) => {
        const proc = spawn(py, ['--version'], { windowsHide: true, shell: false })
        // §12-#9：与 shell / script 通道共用同一解码入口（契约 auto：解释器自行决定）。
        const chunks: Buffer[] = []
        const appendChunk = (d: Buffer) => chunks.push(d)
        proc.stdout?.on('data', appendChunk)
        proc.stderr?.on('data', appendChunk)
        proc.on('error', (err) => {
          resolve({ ok: false, error: err.message })
        })
        proc.on('close', (code) => {
          const v = decodeChildOutput(Buffer.concat(chunks), { contract: AUTO_CONTRACT }).text.trim()
          if (code === 0 && v) resolve({ ok: true, version: v })
          else resolve({ ok: false, error: v || `${ErrorCodes.SHELL_PROCESS_EXIT_CODE}|${code ?? ''}` })
        })
      })
    }
  )

  ipcMain.handle(
    'chat:get-messages',
    (_e, payload: { sessionId: string; limit?: number; offset?: number }): Message[] =>
      getMessages(ctx.db, payload.sessionId, payload.limit ?? 500, payload.offset ?? 0)
  )

  ipcMain.handle(
    'chat:get-api-context-baseline',
    (_e, payload: { sessionId: string }) => getApiContextBaseline(ctx.db, payload.sessionId)
  )

  ipcMain.handle(
    'chat:get-message-page',
    (
      _e,
      payload: { sessionId: string; beforeSequence?: number; limit?: number }
    ) =>
      getChatMessagePage(ctx.db, payload.sessionId, payload.beforeSequence, payload.limit)
  )

  ipcMain.handle('chat:get-display-message-page', (_e, payload: { sessionId: string; beforeSequence?: number; limit?: number }) => {
    const page = getChatMessagePage(ctx.db, payload.sessionId, payload.beforeSequence, payload.limit)
    return { ...page, entries: page.entries.filter(({ message }) => message.role === 'assistant').map(({ message, sequence }) => ({ display: turnToDisplay({ turnId: message.id, requestId: '', version: 0, assistantMessage: message }), sequence })) }
  })

  ipcMain.handle(
    'chat:get-context-history-summary-baseline',
    (_e, payload: { sessionId: string }) =>
      getContextHistorySummaryBaseline(ctx.db, payload.sessionId)
  )

  ipcMain.handle(
    'chat:get-search-corpus-page',
    (
      _e,
      payload: { sessionId: string; fromSequence?: number; limit?: number }
    ) =>
      getSearchCorpusPage(ctx.db, payload.sessionId, payload.fromSequence ?? 0, payload.limit)
  )

  ipcMain.handle('chat:get-next-queued-message', (_e, payload: { sessionId: string }) =>
    getNextQueuedMessage(ctx.db, payload.sessionId)
  )

  ipcMain.handle('chat:enqueue-queued-message', (_e, payload: { sessionId: string; requestId: string; content: string; attachments?: Message['attachments'] }) =>
    enqueueQueuedUserMessage(ctx.db, payload)
  )

  ipcMain.handle(
    'chat:resolve-retry-context',
    (_e, payload: { sessionId: string; failedAssistantMessageId: string }) =>
      resolveRetryContext(ctx.db, payload.sessionId, payload.failedAssistantMessageId)
  )

  ipcMain.handle(
    'chat:get-message-sequence',
    (_e, payload: { sessionId: string; messageId: string }) =>
      getMessageSequence(ctx.db, payload.sessionId, payload.messageId)
  )

  ipcMain.handle(
    'message:append-non-turn',
    async (_e, msg: Message): Promise<{ messageId: string; sequence: number }> => {
      const { message, sequence } = appendMessage(ctx.db, msg)
      scheduleBackup(ctx, message.sessionId)
      return { messageId: message.id, sequence }
    }
  )

  // Phase 1b：prepare 编排抽为内部函数——chat:prepare-turn 与出站受理端口（chat:submit-outbound）
  // 共用同一套 configuring/skill-route/execution-config 装配，避免两处分叉。

  type PreparedTurn = Omit<TurnStarted, 'executionConfig'>

  const prepareTurnInternal = async (intent: TurnIntent): Promise<PreparedTurn> => {
    const configuringKey = JSON.stringify([intent.sessionId, intent.requestId])
    const existing = getTurnByRequestId(ctx.db, intent.sessionId, intent.requestId)
    if (existing) {
      if (existing.state === 'configuring') {
        // 即使同进程单飞，也要先复用 Coordinator 的消息意图校验，拒绝同 requestId 的变形重试。
        turnCoordinator.prepare({ ...intent, config: {} })
        const configuring = configuringTurns.get(configuringKey)
        if (configuring) return (await configuring) as PreparedTurn
        throw new Error('TURN_CONFIGURATION_INCOMPLETE')
      }
      const { executionConfig: _executionConfig, ...prepared } = turnCoordinator.prepare({ ...intent, config: existing.executionConfig ?? {} })
      return prepared
    }
    // 先原子占有 session 并写入 H。立即交还 turnId，使配置/路由阶段可被 cancel-turn 打断。
    const started = turnCoordinator.prepare({ ...intent, config: {} }, 'configuring')
    const controller = new AbortController()
    const configuring = (async () => {
      try {
        const persisted = getPersistedTurn(ctx.db, started.turnId)
        if (!persisted?.userMessageId) throw new Error('TURN_PREPARE_PERSISTENCE_MISSING')
        const session = getSession(ctx.db, intent.sessionId)
        if (!session) throw new Error('TURN_SESSION_NOT_FOUND')
        const reusedUserMessage = intent.mode === 'reuse-user'
          ? getMessage(ctx.db, intent.userMessageId)
          : undefined
        const userInput = intent.mode === 'create-user' ? intent.input.text : reusedUserMessage?.content
        if (userInput == null) throw new Error('TURN_USER_MESSAGE_MISSING')
        const excludeMessageIds = intent.excludeMessageIds ?? []
        const requiresVision = Boolean(
          (intent.mode === 'create-user' && intent.input.attachments?.length) ||
          (intent.mode === 'reuse-user' && reusedUserMessage?.attachments?.length) ||
          hasVisionInTurnRoutingContext(ctx.db, intent.sessionId, persisted.contextBoundarySequence, excludeMessageIds)
        )
        const baseConfig = await resolveTrustedTurnExecutionConfig(
          ctx.db,
          intent.sessionId,
          'desktop',
          { projectMemoryEnabled: true },
          { requiresVision }
        )
        const credentials = await resolveLlmCredentialsForModel(ctx.db, baseConfig.model!, { serviceId: baseConfig.llmServiceId })
        const recentMessages: SkillRouteRecentMessage[] = getRecentTurnRoutingMessages(
          ctx.db,
          intent.sessionId,
          50,
          persisted.contextBoundarySequence,
          excludeMessageIds
        )
        const route = await skillManager.route({
          userInput,
          sessionState: normalizeSessionSkillsState(session.skillsState),
          sessionMetadata: session.metadata,
          recentMessages,
          model: baseConfig.model!,
          baseUrl: credentials.baseUrl,
          getApiKey: credentials.getApiKey,
          sessionId: intent.sessionId,
          signal: controller.signal
        })
        const skillFragments = route.skills.map((skill) => `## Skill: ${skill.meta.name}\n\n${skill.content.trim()}`)
        let system: string | undefined
        if (route.skills.some((skill) => skill.meta.name === 'llm-wiki')) {
          const schema = readWikiSchema(ctx.getWorkDir(), readWikiConfig(ctx.db))?.trim()
          if (schema) system = system ? `${system}\n\n## Wiki Schema（项目规范）\n\n${schema}` : `## Wiki Schema（项目规范）\n\n${schema}`
        }
        const config = { ...baseConfig, ...(system ? { system } : {}), ...(skillFragments.length ? { skillFragments } : {}) }
        const intentFingerprint = JSON.stringify({
          mode: intent.mode,
          userMessageId: intent.mode === 'reuse-user' ? intent.userMessageId : undefined,
          input: intent.mode === 'create-user' ? canonicalQueueInput(intent.input) : undefined,
          excludeMessageIds: [...excludeMessageIds].sort(),
          config: normalizeTurnExecutionConfig(config)
        })
        if (!setPersistedTurnExecutionConfig(ctx.db, started.turnId, config, intentFingerprint)) throw new Error('TURN_EXECUTION_CONFIG_NOT_PREPARED')
        const { executionConfig: _executionConfig, ...prepared } = started
        return prepared
      } catch (error) {
        if (controller.signal.aborted) throw error
        // 路由/配置阶段失败也必须终结已占有的 turn，不能留下永久 configuring 状态。
        // 必须走 runtime 的 consume（而不是 coordinator.consume）才会发出 projection：
        // 否则渲染层收不到终态事实，消息会一直停在「生成中」，用户也看不到失败原因。
        const failureMessage = error instanceof Error ? error.message : String(error)
        const failed = turnRuntime.consume(started.turnId, { type: 'source-failed', message: failureMessage })
        failConfiguringTurn(ctx.db, started.turnId, failed.version, {
          code: 'configuration-failed',
          message: failureMessage
        })
        throw error
      }
    })()
    configuringTurns.set(configuringKey, configuring)
    configuringTurnsById.set(started.turnId, configuring)
    configuringAbortControllers.set(started.turnId, controller)
    void configuring.then(
      () => {
        if (configuringTurns.get(configuringKey) === configuring) configuringTurns.delete(configuringKey)
        if (configuringTurnsById.get(started.turnId) === configuring) configuringTurnsById.delete(started.turnId)
        if (configuringAbortControllers.get(started.turnId) === controller) configuringAbortControllers.delete(started.turnId)
      },
      () => {
        if (configuringTurns.get(configuringKey) === configuring) configuringTurns.delete(configuringKey)
        if (configuringTurnsById.get(started.turnId) === configuring) configuringTurnsById.delete(started.turnId)
        if (configuringAbortControllers.get(started.turnId) === controller) configuringAbortControllers.delete(started.turnId)
      }
    )
    const { executionConfig: _executionConfig, ...prepared } = started
    return prepared
  }

  ipcMain.handle('chat:prepare-turn', (_e, intent: TurnIntent) => prepareTurnInternal(intent))
  // Phase 1b：execute 编排抽为内部函数——chat:execute-turn 与出站受理端口共用。
  // sender 为 null 表示主进程内部驱动源（排水器/受理端口）发起，事件出口不依赖 sender。

  const executeTurnInternal = async (sender: Electron.WebContents | null, payload: TurnExecutePayload) => {
    if (!ctx.executeTurn) throw new Error('TURN_EXECUTOR_NOT_CONFIGURED')
    if (!payload || typeof payload !== 'object' || typeof payload.turnId !== 'string' || typeof payload.turnStartToken !== 'string') {
      throw new Error('INVALID_TURN_EXECUTION_PAYLOAD')
    }
    const executionPayload = { requestId: payload.requestId, turnId: payload.turnId, turnStartToken: payload.turnStartToken, sessionId: payload.sessionId }
    const configuring = configuringTurnsById.get(payload.turnId)
    const persisted = getPersistedTurn(ctx.db, payload.turnId)
    if (persisted?.state === 'terminal') return { ok: true as const, accepted: false as const, turnId: payload.turnId }
    if (persisted?.state === 'configuring' && !configuring) throw new Error('TURN_CONFIGURATION_INCOMPLETE')
    void (async () => {
      try {
        if (configuring) await configuring
        await ctx.executeTurn!(sender, executionPayload)
      } catch {
        // 配置失败/取消已由 configuring 路径写入 terminal，不能把它伪装成 legacy config 错误。
      }
    })()
    return { ok: true as const, accepted: true as const, turnId: payload.turnId }
  }

  ipcMain.handle('chat:execute-turn', (event, payload: TurnExecutePayload) => executeTurnInternal(event.sender, payload))

  // Phase 1b：出站受理端口——渲染端只提交意图，发起/排队/本地命令/守卫全部由主进程决定（偏差 9 回收）。

  const outboundAcceptor = createOutboundAcceptor({
    db: ctx.db,
    turnRuntime,
    isDev: () => !app.isPackaged,
    apiKeyPresent: () => {
      const services = readLlmServices(ctx.db)
      const activeId = readActiveLlmServiceId(ctx.db)
      const active = services.find((s) => s.id === activeId) ?? services[0]
      return active?.apiKeyPresent ?? Boolean(getConfigValue(ctx.db, CONFIG_KEYS.apiKeyEnc))
    },
    getMaxParallel: () => {
      const raw = getConfigValue(ctx.db, CONFIG_KEYS.maxParallelChatSessions)
      return clampMaxParallelChatSessions(raw ? Number(raw) : undefined)
    },
    readWikiConfig: () => readWikiConfig(ctx.db),
    listSkills: async () => skillManager.list(true),
    getSkill: async (payload) => skillManager.get(payload.name),
    wikiInit: async (payload) =>
      initWikiStructure(ctx.getWorkDir(), readWikiConfig(ctx.db), {
        overwrite: payload?.overwrite === true,
        installSkill: payload?.installSkill !== false
      }),
    wikiStatus: async () => getWikiStatus(ctx.getWorkDir(), readWikiConfig(ctx.db)),
    wikiImportRaw: (payload) => importRawFromWorkDir(ctx.getWorkDir(), readWikiConfig(ctx.db), payload.srcRelPath),
    appendHintMessage: async (sessionId, hint) => {
      const msg = createSkillHintSystemMessage(sessionId, hint)
      const { sequence } = appendMessage(ctx.db, msg)
      scheduleBackup(ctx, sessionId)
      return { messageId: msg.id, sequence }
    },
    updateSessionState: async (sessionId, patch) => {
      if (!getSession(ctx.db, sessionId)) return
      updateSession(ctx.db, sessionId, {
        ...(patch.skillsState ? { skillsState: patch.skillsState } : {}),
        ...(patch.metadataPatch ? { metadata: patch.metadataPatch } : {})
      })
    },
    createSession: async (prefs) => {
      // B2:无会话首条消息的 composer 草稿偏好随代建落库（thinkingEffort 校验在 operations 层）
      const s = createSession(ctx.db, {
        name: '',
        workDirProfileId: ctx.workDirManager.getActiveProfileId(),
        ...(prefs?.model ? { model: prefs.model } : {}),
        ...(prefs?.llmServiceId ? { llmServiceId: prefs.llmServiceId } : {}),
        ...(prefs?.thinkingEffort ? { thinkingEffort: prefs.thinkingEffort } : {})
      })
      await fs.mkdir(ctx.getWorkDir(), { recursive: true })
      return s
    },
    startTurn: async ({ turnIntent }) => {
      const started = await prepareTurnInternal(turnIntent)
      // 主进程驱动 execute：渲染端不再持有 execute 调用时机（1c 落实渲染端退役）
      void executeTurnInternal(null, {
        requestId: started.requestId,
        turnId: started.turnId,
        turnStartToken: started.startToken,
        sessionId: started.sessionId
      })
      return { turnId: started.turnId, assistantMessage: started.assistantMessage }
    },
    ensureSessionWorkDir: async (sessionId) => {
      // B2(v2 评审):main ensureWorkDirForSession 语义回收——turn 执行用 active profile 目录,
      // 会话绑定 profile 与 active 不一致时切过去,失败即拒绝(不写错目录)
      const session = getSession(ctx.db, sessionId)
      const target = session?.workDirProfileId
      if (!target || target === ctx.workDirManager.getActiveProfileId()) return { ok: true as const }
      const result = await ctx.workDirManager.switchProfile(target)
      return result.success ? { ok: true as const } : { ok: false as const, error: result.error ?? '切换失败' }
    },
    notifyEnqueued: (sessionId) => {
      // B3(v2 评审):enqueue 落库后若无 active turn,补一次排水(闭环 snapshot→enqueue 窗口竞态)
      if (turnRuntime.listActive(sessionId).length === 0) void outboundDrainer.drain(sessionId)
    },
    contextUsageWarn: async ({ sessionId, attachments }) => computeContextPressureWarnings(ctx.db, sessionId, attachments),
    newRequestId: () => randomUUID(),
    audit: (event, data) => logAgentEvent('warn', event as AgentLogEventName, data as AgentLogFields)
  })

  ipcMain.handle('chat:submit-outbound', (_e, intent: OutboundSubmitIntent) => outboundAcceptor.submitOutbound(intent))

  // 主进程排水器：turn 终态后取队首 queued 驱动下一回合（偏差 9 核心条目——「何时发起下一回合」回主进程）。
  // 渲染端 drainQueueForSession 触发器在 1c 删除，此前两者并存（先建后删，避免双驱空窗）。

  const outboundDrainer = createOutboundDrainer({
    submitOutbound: outboundAcceptor.submitOutbound,
    listActiveCount: (sessionId) => turnRuntime.listActive(sessionId).length,
    getNextQueued: (sessionId) => getNextQueuedMessage(ctx.db, sessionId),
    consumeQueued: (_sessionId, messageId) => {
      // B5:排队的渲染端本地命令(如 /test-cards)主进程无法执行,消费落库避免卡队
      deleteQueuedUserMessage(ctx.db, messageId)
    },
    audit: (event, data) => logAgentEvent('warn', event as AgentLogEventName, data as AgentLogFields)
  })
  turnRuntime.subscribe((turn, event) => outboundDrainer.onTurnProjection(turn, event))

  ipcMain.handle('chat:cancel-turn', (_e, turnId: string) => {
    const controller = configuringAbortControllers.get(turnId)
    cancelClaudeAdmission(turnId)
    const turn = typeof turnRuntime.getTurn === 'function' ? turnRuntime.getTurn(turnId) : undefined
    if (turn?.requestId) getCallAdmissionGate().cancel(turn.requestId)
    const cancelled = turnRuntime.cancel(turnId)
    if (cancelled && controller) {
      controller.abort()
      configuringAbortControllers.delete(turnId)
      const configuring = configuringTurnsById.get(turnId)
      if (configuring) {
        configuringTurnsById.delete(turnId)
        for (const [key, promise] of configuringTurns) {
          if (promise === configuring) configuringTurns.delete(key)
        }
      }
    }
    return cancelled
  })

  ipcMain.handle('chat:get-turn-terminal', (_e, turnId: string) => {
    const terminal = turnCoordinator.getTerminal(turnId)
    return terminal ? { ...terminal, committedVersion: turnCoordinator.getCommittedVersion(turnId), commitStatus: turnCoordinator.getCheckpointStatus(turnId) } : undefined
  })

  ipcMain.handle('chat:retry-turn-checkpoint', (_e, turnId: string) => { turnRuntime.retryCheckpoint(turnId); return true })
  // 重开页面时渲染层只有消息 id：按 assistantMessageId 回查终态失败原因，
  // 否则历史失败气泡永远只剩通用提示。内存终态比持久化记录新，优先采纳。

  ipcMain.handle('chat:get-turn-errors', (_e, payload?: { assistantMessageIds?: unknown }) => {
    const requested = Array.isArray(payload?.assistantMessageIds) ? payload.assistantMessageIds : []
    const ids = requested.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    if (ids.length === 0) return []
    const errors = new Map(listTurnErrorsByAssistantMessageIds(ctx.db, ids).map((entry) => [entry.assistantMessageId, entry.message]))
    for (const id of ids) {
      const live = turnCoordinator.getTerminalByAssistantMessageId(id)?.error?.message?.trim()
      if (live) errors.set(id, live)
    }
    return [...errors].map(([assistantMessageId, message]) => ({ assistantMessageId, message }))
  })

  ipcMain.handle('chat:list-active-turns', (_e, payload?: { sessionId?: string }) => turnRuntime.listActive(payload?.sessionId).map(({ executionConfig: _executionConfig, ...turn }) => turn))

  ipcMain.handle('chat:get-turn-displays', (_e, payload: { known: Array<{ turnId: string; version: number }>; sessionId?: string }) => {
    const known = new Map((payload?.known ?? []).map((item) => [item.turnId, item.version]))
    const active = turnRuntime.listActive(payload?.sessionId)
    const changed = active
      .filter((turn) => turn.version > (known.get(turn.turnId) ?? -1))
      .map((turn) => turnToDisplay(turn))
    // terminal 只用于接管 renderer 仍认为活动中的 turn，或 renderer 重载时仍在 checkpoint 窗口内的 turn。
    for (const terminal of turnRuntime.listTerminals(payload?.sessionId)) {
      const knownVersion = known.get(terminal.turnId)
      const checkpointStatus = turnRuntime.checkpointStatus(terminal.turnId, terminal.version)
      const shouldRecoverCheckpoint = checkpointStatus !== 'committed'
      if ((knownVersion !== undefined && terminal.version > knownVersion) || (knownVersion === undefined && shouldRecoverCheckpoint)) {
        changed.push(turnToDisplay({ turnId: terminal.turnId, requestId: terminal.requestId, version: terminal.version, outcome: terminal.outcome === 'recovered' ? 'completed' : terminal.outcome, assistantMessage: terminal.message }))
      }
    }
    return { changed }
  })

  ipcMain.handle('chat:get-tool-call-details', (_e, payload: { sessionId: string; turnId: string; messageId: string; toolCallId: string }) => {
    const turn = turnRuntime.getTurn(payload.turnId)
    const terminal = turnRuntime.terminal(payload.turnId)
    const message = turn?.assistantMessage ?? terminal?.message
    if (!message || message.sessionId !== payload.sessionId || message.id !== payload.messageId) return undefined
    return message.toolCalls?.find((tool) => tool.id === payload.toolCallId)
  })

  ipcMain.handle('chat:get-pending-confirmation', (_e, payload: { sessionId: string; turnId: string; requestId: string; turnVersion: number; toolCallId: string }) => {
    const turn = turnRuntime.getTurn(payload.turnId)
    if (!turn || turn.sessionId !== payload.sessionId || turn.requestId !== payload.requestId || turn.version !== payload.turnVersion) return { status: 'stale' as const }
    const tool = turn.assistantMessage.toolCalls?.find((candidate) => candidate.id === payload.toolCallId && candidate.status === 'confirming')
    if (!tool) return { status: 'not-awaiting' as const }
    return toConfirmationSnapshot({ sessionId: payload.sessionId, turnId: payload.turnId, requestId: payload.requestId, turnVersion: payload.turnVersion, tool })
  })

  ipcMain.handle(
    'message:patch-non-turn',
    async (_e, payload: {
      messageId: string
      patch: Partial<
        Pick<
          Message,
          | 'content'
          | 'status'
          | 'toolUse'
          | 'thinking'
          | 'toolCalls'
          | 'contentSegments'
          | 'skillHints'
          | 'attachments'
          | 'imagesDeliveredToApi'
        >
      >
    } & { sessionId: string }): Promise<{ message: Message; sequence: number } | null> => {
      const entry = updateMessageContent(ctx.db, payload.messageId, payload.patch)
      if (!entry) return null
      await backupAfterMessagePatch(ctx, payload.sessionId, payload.patch)
      return entry
    }
  )

  ipcMain.handle(
    'chat:stage-image',
    async (
      _e,
      args: { sessionId: string; fileName: string; mimeType: string; dataBase64: string }
    ): Promise<ChatImageAttachment | { error: string }> => {
      return stageChatImage({ userDataDir: ctx.getUserDataPath(), ...args })
    }
  )

  ipcMain.handle(
    'chat:discard-staged-image',
    async (_e, args: { sessionId: string; stagingKey: string }): Promise<{ ok: true } | { error: string }> => {
      void args.sessionId
      return discardStagedImage(ctx.getUserDataPath(), args.stagingKey)
    }
  )

  ipcMain.handle(
    'chat:read-staged-image',
    async (
      _e,
      args: { sessionId: string; stagingKey: string; maxBytes?: number }
    ): Promise<{ mimeType: string; dataBase64: string } | { error: string }> => {
      void args.sessionId
      return readStagedImage({
        userDataDir: ctx.getUserDataPath(),
        stagingKey: args.stagingKey,
        maxBytes: args.maxBytes
      })
    }
  )

  ipcMain.handle(
    'chat:delete-queued-message',
    async (_e, payload: { messageId: string; sessionId: string }) => {
      const result = deleteQueuedUserMessage(ctx.db, payload.messageId)
      if (result.ok) {
        await flushBackup(ctx, result.sessionId)
      }
      return result
    }
  )

  ipcMain.handle(
    'exposure:get-tools',
    async (_e, payload: { lane: 'desktop' | 'wechat' | 'feishu' }): Promise<string[]> => {
      // 主进程为唯一评估者：一律读 DB 配置求值，不信任渲染端上行的 config（§5.2 exposure 定稿）
      const { exposedToolNamesForLane } = await import('../toolsConfigRuntime')
      const { loadEffectivePolicyRules } = await import('../confirmation/policyRulesRuntime')
      return exposedToolNamesForLane(
        payload.lane,
        ...readExposureInputsFromDb(ctx.db),
        undefined,
        loadEffectivePolicyRules(ctx.db, payload.lane)
      )
    }
  )

  // ===== 「安全策略」设置页（§7 五区，P4）=====
  // 启动时把持久化的审计保留天数注入审计单例（设置页可调，§5.6-1）。

  ipcMain.handle('skill:list', async (): Promise<SkillDefinition[]> => skillManager.list(true))

  ipcMain.handle('skill:probe-github-url', async (_e, payload: { sourceUrl: string }) => {
    try { return { ok: true as const, ...(await skillManager.probeFromUrl(payload.sourceUrl)) } }
    catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : String(e) } }
  })

  ipcMain.handle('skill:scan-status', async () => scanSkillsWithSkipped(ctx.getUserDataPath(), ctx.getWorkDir()))

  ipcMain.handle('skill:get', async (_e, payload: { name: string }): Promise<SkillDefinition | null> => {
    return skillManager.get(payload.name)
  })

  ipcMain.handle(
    'skill:match',
    async (_e, payload: { userInput: string; sessionSkillsState: SessionSkillsState; sessionMetadata?: Record<string, unknown> }): Promise<SkillDefinition[]> => {
      const matched = skillManager.match(
        payload.userInput,
        normalizeSessionSkillsState(payload.sessionSkillsState),
        payload.sessionMetadata
      )
      if (matched.length > 0) {
        const systemPrompt = skillManager.buildSystemPrompt(matched)
        logAgentEvent('info', 'skills.invoke', {
          skillNames: matched.map((s) => s.meta.name),
          systemPromptLength: systemPrompt.length
        })
      }
      return matched
    }
  )

  ipcMain.handle(
    'skill:route',
    async (
      _e,
      payload: {
        userInput: string
        sessionSkillsState: SessionSkillsState
        sessionId?: string
        sessionMetadata?: Record<string, unknown>
        recentMessages?: SkillRouteRecentMessage[]
        model?: string
      }
    ): Promise<SkillRouteResult> => {
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : undefined
      const session = sessionId ? getSession(ctx.db, sessionId) : undefined

      let models: ModelEntry[] = []
      const rawModels = getConfigValue(ctx.db, CONFIG_KEYS.models)
      if (rawModels) {
        try {
          models = JSON.parse(rawModels) as ModelEntry[]
        } catch {
          models = []
        }
      }

      const routeModelName =
        (typeof payload.model === 'string' && payload.model.trim()) ||
        session?.model ||
        resolveFastPreferredModelName(ctx.db, models) ||
        resolveLanguagePreferredModelName(ctx.db, models)

      const creds = await resolveLlmCredentialsForModel(ctx.db, routeModelName, {
        serviceId: session?.llmServiceId,
        models
      })
      const baseUrl = creds.baseUrl
      const getApiKey = creds.getApiKey

      const result = await skillManager.route({
        userInput: payload.userInput,
        sessionState: normalizeSessionSkillsState(payload.sessionSkillsState),
        sessionMetadata: payload.sessionMetadata ?? session?.metadata,
        recentMessages: payload.recentMessages,
        model: routeModelName,
        baseUrl,
        getApiKey,
        sessionId
      })

      if (result.skills.length > 0) {
        const systemPrompt = skillManager.buildSystemPrompt(result.skills)
        logAgentEvent('info', 'skills.invoke', {
          skillNames: result.skills.map((s) => s.meta.name),
          systemPromptLength: systemPrompt.length,
          sources: result.meta.sources
        })
      }

      return result
    }
  )

  ipcMain.handle(
    'skill:install',
    async (_e, payload: { sourcePath: string; overwrite?: boolean }): Promise<{ ok: true; skill: SkillDefinition } | { ok: false; error: string }> => {
      try {
        const skill = await skillManager.install(payload.sourcePath, payload.overwrite === true)
        return { ok: true, skill }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  ipcMain.handle(
    'skill:install-from-url',
    async (
      event,
      payload: { sourceUrl: string; subPath?: string; subPaths?: string[]; installAll?: boolean; overwrite?: boolean }
    ): Promise<
      | { ok: true; skills: SkillDefinition[]; skipped: SkippedCandidate[]; overwritten: string[] }
      | { ok: false; error: string }
    > => {
      try {
        activeSkillInstallAbort = new AbortController()
        const result = await skillManager.installFromUrl(payload.sourceUrl, {
          subPath: payload.subPath,
          subPaths: payload.subPaths,
          installAll: payload.installAll === true,
          overwrite: payload.overwrite === true,
          onProgress: (progress) => event.sender.send('skill-install-progress', progress),
          signal: activeSkillInstallAbort.signal
        })
        return { ok: true, skills: result.installed, skipped: result.skipped, overwritten: result.overwritten }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      } finally { activeSkillInstallAbort = null }
    }
  )

  ipcMain.handle('skill:cancel-install', async () => { activeSkillInstallAbort?.abort() })

  ipcMain.handle('skill:delete', async (_e, payload: { name: string }): Promise<void> => {
    skillManager.delete(payload.name)
  })

  ipcMain.handle('skill:toggle-disable', async (_e, payload: { name: string; disabled: boolean }): Promise<void> => {
    const cur = readSkillsConfig(ctx.db)
    const set = new Set(cur.disabled)
    if (payload.disabled) set.add(payload.name)
    else set.delete(payload.name)
    setConfigValue(ctx.db, CONFIG_KEYS.skills, JSON.stringify({ ...cur, disabled: [...set] }))
  })

  ipcMain.handle('skill:open-directory', async (_e, payload: { scope: 'user' | 'project' }): Promise<void> => {
    ensureSkillsDirs(ctx.getUserDataPath(), ctx.getWorkDir())
    const dir =
      payload.scope === 'project'
        ? getProjectSkillsDir(ctx.getWorkDir())
        : getUserSkillsDir(ctx.getUserDataPath())
    if (!dir) throw new Error(ErrorCodes.WORK_DIR_NOT_CONFIGURED)
    await shell.openPath(dir)
  })

  ipcMain.handle(
    'skill:export',
    async (_e, payload: { name: string; destPath: string }): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await skillManager.exportSkill(payload.name, payload.destPath)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  ipcMain.handle(
    'wiki:import-raw',
    async (event, payload: { srcRelPath: string }) => {
      const wikiConfig = readWikiConfig(ctx.db)
      const result = await importRawFromWorkDir(ctx.getWorkDir(), wikiConfig, payload.srcRelPath)
      const treeChange = wikiImportFileTreeChange(result)
      if (treeChange) notifyFileTreeChanged(event.sender, treeChange)
      return result
    }
  )

  ipcMain.handle('wiki:init', async (_e, payload: { overwrite?: boolean; installSkill?: boolean } = {}) => {
    const wikiConfig = readWikiConfig(ctx.db)
    const result = await initWikiStructure(ctx.getWorkDir(), wikiConfig, {
      overwrite: payload.overwrite === true,
      installSkill: payload.installSkill !== false
    })
    if (result.ok) skillManager.invalidateCache()
    return result
  })

  ipcMain.handle('wiki:status', async (): Promise<WikiStatus> => {
    const wikiConfig = readWikiConfig(ctx.db)
    return getWikiStatus(ctx.getWorkDir(), wikiConfig)
  })

  ipcMain.handle('wiki:get-schema', async (): Promise<{ content: string } | null> => {
    const wikiConfig = readWikiConfig(ctx.db)
    const content = readWikiSchema(ctx.getWorkDir(), wikiConfig)
    return content ? { content } : null
  })

  ipcMain.handle(
    'wiki:resolve-path',
    async (_e, payload: { relPath: string }): Promise<{ absPath: string; kind: ReturnType<typeof classifyWikiPath> } | { error: string }> => {
      try {
        const wikiConfig = readWikiConfig(ctx.db)
        const root = ctx.getWorkDir()
        const absPath = await resolveSafePath(root, payload.relPath)
        const rel = path.relative(root, absPath).replace(/\\/g, '/')
        return { absPath, kind: classifyWikiPath(root, wikiConfig, rel) }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  ipcMain.handle('skill:invalidate-cache', async (): Promise<void> => {
    skillManager.invalidateCache()
  })

  ipcMain.handle('project-memory:get-state', async () => {
    return getCachedMemoryState()
  })

  ipcMain.handle('project-memory:reload', async () => {
    const workDir = ctx.getWorkDir()
    const state = await loadProjectMemory(workDir)
    return state
  })

  ipcMain.handle('project-memory:write', async (_event, payload: { content: string }) => {
    try {
      const workDir = ctx.getWorkDir()
      await writeProjectMemory(workDir, payload.content)
      return { success: true as const }
    } catch (err) {
      return { success: false as const, error: (err as Error).message }
    }
  })

  ipcMain.handle('project-memory:generate', async () => {
    try {
      const workDir = ctx.getWorkDir()

      // Check if file already exists
      const memoryPath = path.join(workDir, 'SPACEASSISTANT.md')
      if (existsSync(memoryPath)) {
        return { success: false as const, error: ErrorCodes.PROJECT_MEMORY_ALREADY_EXISTS }
      }

      const prompt = await generateProjectMemory(workDir)

      const apiKey = await ctx.getApiKey()
      if (!apiKey) {
        return { success: false as const, error: ErrorCodes.API_KEY_NOT_CONFIGURED }
      }

      const client = createAnthropicClient(apiKey, undefined)

      const model =
        (getConfigValue(ctx.db, CONFIG_KEYS.defaultModel) as string) ?? 'claude-sonnet-4-20250514'

      const res = await client.messages.create({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user' as const, content: prompt }]
      })

      const content = res.content[0]?.type === 'text' ? res.content[0].text : ''
      if (!content) {
        return { success: false as const, error: ErrorCodes.LLM_EMPTY_RESPONSE }
      }

      await writeProjectMemory(workDir, content)

      return { success: true as const, prompt, content }
    } catch (err) {
      return { success: false as const, error: (err as Error).message }
    }
  })
}
