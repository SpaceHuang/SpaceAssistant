import type { AppDatabase } from '../database/sqliteStore'
import type { RemoteContext } from '../tools/types'
import type { SessionStorage } from '../sessionStorage/host/ports'
import type { TypedToolRegistry } from '../tools/plannedToolRegistry'
import { assembleInvocation } from '../runtime/invocationAssembler'
import type { WorkDirManager } from '../workDirManager'
import type { ToolsConfig, BrowserConfig, ShellConfig, WikiConfig } from '../../src/shared/domainTypes'
import { readWikiConfig } from '../wiki/wikiConfigReader'

/** Rebuild the current IM tool host and dispatch only the immutable persisted call; never starts a model turn. */
export async function executeDeferredImTool(input: {
  db: AppDatabase
  sessionStorage: SessionStorage
  sessionId: string
  requestId: string
  turnId: string
  invocationId: string
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  confirmationReceipt?: string
  confirmationPolicyRevision?: string
  policyOnly?: boolean
  lane: 'feishu' | 'wechat'
  remoteContext: RemoteContext
  model: string
  providerRouteId: string
  toolsConfig: ToolsConfig
  workDir: string
  userDataDir: string
  getApiKey: () => Promise<string | null>
  getBaseUrl: () => string
  workDirManager: WorkDirManager
  getBrowserConfig?: () => BrowserConfig
  getShellConfig?: () => ShellConfig
  getWikiConfig?: () => WikiConfig
  toolChatExtras?: Pick<import('../runtime/invocationAssembler').AgentInvocationMaterials, 'feishuConfig' | 'wechatConfig' | 'larkCliRunner'>
  registry?: TypedToolRegistry
}): Promise<unknown> {
  if (input.remoteContext.source !== input.lane || input.remoteContext.originSessionId !== input.sessionId ||
    input.remoteContext.authOwner?.trim() === '' || !input.remoteContext.authOwner) {
    throw new Error('DEFERRED_IM_EXECUTION_SCOPE_INVALID')
  }
  const getWikiConfig = input.getWikiConfig ?? (() => readWikiConfig(input.db))
  const { agentSdk } = assembleInvocation({
    requestId: input.requestId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    model: input.model,
    providerRouteId: input.providerRouteId,
    lane: input.lane,
    messages: [],
    toolsConfig: input.toolsConfig,
    resolveToolsConfig: () => input.toolsConfig,
    ...(input.getBrowserConfig ? { browserConfig: input.getBrowserConfig(), resolveBrowserConfig: input.getBrowserConfig } : {}),
    ...(input.getShellConfig ? { shellConfig: input.getShellConfig(), resolveShellConfig: input.getShellConfig } : {}),
    wikiConfig: getWikiConfig(),
    resolveWikiConfig: getWikiConfig,
    workDir: input.workDir,
    workDirManager: input.workDirManager,
    resolveWorkDir: () => input.workDir,
    userDataDir: input.userDataDir,
    getApiKey: input.getApiKey,
    appDb: input.db,
    sessionStorage: input.sessionStorage,
    historyForSession: (sessionId) => input.sessionStorage.execution.historyFor({ sessionId }),
    remoteContext: input.remoteContext,
    ...input.toolChatExtras,
    emitFactEvent: () => undefined,
    emitSessionEvent: () => undefined
  })
  const runtime = agentSdk.createHostedTurnRuntime({
    ...(input.registry ? { registry: input.registry } : {}),
    authorizedToolNames: new Set([input.toolName])
  })
  try {
    if (input.policyOnly) {
      const call = { invocationId: input.invocationId, toolCallId: input.toolCallId, toolName: input.toolName,
        input: structuredClone(input.input) }
      try {
        const binding = await runtime.registeredTools.prepareTool(call, { kind: 'initial' })
        const decision = await runtime.policy.evaluate({ ...binding,
          capability: { state: 'known-authorized', id: binding.capabilityId } })
        return { decision, policy: runtime.registeredTools.getPolicyDecisionMetadata(call) }
      } finally {
        runtime.registeredTools.discardPreparedTool(call)
      }
    }
    if (!input.confirmationReceipt?.trim()) throw new Error('DEFERRED_CONFIRMATION_RECEIPT_REQUIRED')
    return await runtime.executeDeferred({
      invocationId: input.invocationId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      input: structuredClone(input.input)
    }, input.confirmationReceipt, input.confirmationPolicyRevision)
  } finally {
    await runtime.dispose()
  }
}
