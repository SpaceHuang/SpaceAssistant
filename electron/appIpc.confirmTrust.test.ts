import { describe, expect, it, vi, beforeEach } from 'vitest'
import { registerAppIpcHandlers } from './appIpc'
import type { AppIpcContext } from './appIpc'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() }
}))

const { mockGetConfigValue } = vi.hoisted(() => ({ mockGetConfigValue: vi.fn(() => null) }))

vi.mock('./database', () => ({
  listSessions: vi.fn(() => []),
  createSession: vi.fn(),
  getSession: vi.fn(),
  updateSession: vi.fn(),
  deleteSession: vi.fn(),
  getMessages: vi.fn(() => []),
  appendMessage: vi.fn(),
  updateMessageContent: vi.fn(),
  getConfigValue: mockGetConfigValue,
  deleteConfigValue: vi.fn(),
  setConfigValue: vi.fn(),
  appendSearchHistory: vi.fn(),
  listSearchHistory: vi.fn(() => []),
  setSessionUsage: vi.fn(),
  getSessionUsage: vi.fn(),
  deleteSessionUsage: vi.fn(),
  getDbConnection: vi.fn(() => ({}))
}))

const mockAddTrustedCommand = vi.fn(() => ({ executable: 'git', fixedArgvPrefix: ['status'] }))
const mockAddTrustedDomain = vi.fn((browser: unknown, domain: string) => browser)

vi.mock('./shell/shellCommandTrust', () => ({
  addTrustedCommand: (...args: unknown[]) => mockAddTrustedCommand(...(args as [unknown, unknown])),
  listTrustedCommands: vi.fn(() => []),
  removeTrustedCommands: vi.fn(() => []),
  cleanExpiredTrustedCommands: vi.fn()
}))

vi.mock('./browser/browserDomainTrust', () => ({
  addTrustedDomain: (browser: unknown, domain: string) => mockAddTrustedDomain(browser, domain),
  addTrustedActDomain: (browser: unknown, domain: string) => mockAddTrustedDomain(browser, domain)
}))

vi.mock('./mcp/mcpSessionTrust', () => ({
  rememberMcpSessionTrust: vi.fn()
}))

vi.mock('./confirmation/settingsAudit', () => ({
  recordSettingsChange: vi.fn()
}))

vi.mock('./confirmation/decisionCacheWriter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./confirmation/decisionCacheWriter')>()),
  recordTrustToCache: vi.fn(),
  recordSystemManagedCacheEntry: vi.fn(),
  recordUserAnswerFromMemoryTiers: vi.fn(),
  recordUserAnswerFromDecision: vi.fn()
}))

vi.mock('./confirmation/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./confirmation/audit')>()),
  getSecurityAuditLog: vi.fn(() => ({ record: vi.fn() }))
}))

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn(),
  logAgentError: vi.fn()
}))

import { waitForToolConfirm, clearToolCancel } from './toolConfirmRegistry'

const mockIpcMain = () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
    getHandler: (channel: string) => handlers.get(channel)
  }
}

function makeCtx(): AppIpcContext {
  return {
    db: { save: vi.fn(), flushSave: vi.fn() } as unknown as AppIpcContext['db'],
    backup: { schedule: vi.fn(), flush: vi.fn(), backupImmediate: vi.fn(), deleteBackup: vi.fn() } as unknown as AppIpcContext['backup'],
    workDirManager: {
      listProfiles: () => [],
      addProfile: vi.fn(),
      updateProfile: vi.fn(),
      removeProfile: vi.fn(),
      switchProfile: vi.fn(),
      getActiveProfile: () => undefined,
      getActiveWorkDir: () => '/fake/workdir',
      migrateFromLegacy: vi.fn(),
      persistProfiles: vi.fn(),
      validateProfilesForSave: () => ({ valid: true }),
      validateProfileInput: () => ({ valid: true }),
      checkDirectoryWritable: () => ({ ok: true })
    } as unknown as AppIpcContext['workDirManager'],
    getWorkDir: () => '/fake/workdir',
    setWorkDir: vi.fn(),
    getUserDataPath: () => '/fake/userdata',
    getApiKey: vi.fn().mockResolvedValue(null),
    setApiKey: vi.fn(),
    getBrowserDetectContext: () => ({ isPackaged: false, appPath: '/fake/app', devRoot: '/fake/project' })
  }
}

/**
 * H1（评审）：tool:confirm-response 的信任写入必须与 pending 确认挂钩。
 * agent 裁决路径（AgentChannel）不在 registry 登记 waiter，其残留卡片上的
 * 「信任并允许」点击此前会照常持久化信任——现要求 pending 存在才接受。
 */
describe('tool:confirm-response 信任写入与 pending 确认挂钩（H1）', () => {
  let ipc: ReturnType<typeof mockIpcMain>

  beforeEach(() => {
    vi.clearAllMocks()
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, makeCtx())
  })

  const invoke = (payload: Record<string, unknown>) =>
    ipc.getHandler('tool:confirm-response')?.(null, payload) as Promise<void>

  it('无 pending 确认时：trustCommand 不写入（残留卡片点击是空操作）', async () => {
    await invoke({
      requestId: 'req-no-pending',
      toolUseId: 'tu-1',
      approved: true,
      trustCommand: 'git status',
      sessionId: 's1'
    })
    expect(mockAddTrustedCommand).not.toHaveBeenCalled()
  })

  it('无 pending 确认时：trustDomain / trustActDomain / trustMcpServerId 均不写入', async () => {
    await invoke({ requestId: 'req-x', toolUseId: 'tu-2', approved: true, trustDomain: 'evil.example.com', sessionId: 's1' })
    await invoke({ requestId: 'req-x', toolUseId: 'tu-3', approved: true, trustActDomain: 'evil.example.com', sessionId: 's1' })
    await invoke({
      requestId: 'req-x',
      toolUseId: 'tu-4',
      approved: true,
      trustMcpServerId: 'srv',
      trustMcpToolName: 'query',
      sessionId: 's1'
    })
    expect(mockAddTrustedDomain).not.toHaveBeenCalled()
  })

  it('存在 pending 确认时：信任写入照常（用户确认路径行为不变）', async () => {
    // 模拟 DesktopChannel 已登记的 waiter（waitForToolConfirm 会注册 pending）
    void waitForToolConfirm('req-live', 'tu-live', undefined, { toolName: 'run_shell', lane: 'desktop' })
    try {
      await invoke({
        requestId: 'req-live',
        toolUseId: 'tu-live',
        approved: true,
        trustCommand: 'git status',
        sessionId: 's1'
      })
      expect(mockAddTrustedCommand).toHaveBeenCalledTimes(1)
    } finally {
      clearToolCancel('req-live', 'tu-live')
    }
  })
})
