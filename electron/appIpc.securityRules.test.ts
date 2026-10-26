import { afterAll, describe, expect, it, vi, beforeEach } from 'vitest'
import path from 'path'
import { registerAppIpcHandlers as registerAppIpcHandlersRaw } from './appIpc'
import { withSessionRuntime } from './testSupport/sessionStorageComposition'
import type { AppIpcContext } from './appIpc'

import { createMemoryAppDb } from './database/testHelpers'
import { isToolRevoked, registerToolRevocationRequest, clearToolRevocationRequest } from './toolRevocationRegistry'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import { createAgentRuntime } from './runtime/agentRuntime'
import { setDefaultAgentRuntime } from './runtime/agentRuntimeDefaults'
import { createBuiltinToolRegistry } from './tools/builtinExecutors'
import { ConfirmIdSpace } from './remote/confirmId'
import { ChatCancelRegistry } from './chatCancelRegistry'
import { ToolRevocationRegistry } from './toolRevocationRegistry'
import { McpConcurrencyGate } from './mcp/mcpToolExecutor'
import { PolicyAuthorizationChangeRegistry } from './runtime/policyAuthorizationChangeRegistry'


const TEST_DB = createMemoryAppDb()
afterAll(() => TEST_DB.close())

const WORK_DIR = path.resolve('/fake/workdir')

vi.mock('fs/promises', () => ({
  default: {},
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn()
}))

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
  setSessionUsage: vi.fn(),
  getSessionUsage: vi.fn(),
  deleteSessionUsage: vi.fn(),
  getDbConnection: vi.fn(() => ({}))
}))

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicStreamPort: (client: { messages: { stream: (...args: unknown[]) => unknown } }) => ({ stream: (...args: unknown[]) => client.messages.stream(...args) }),
  createAnthropicClient: vi.fn()
}))

vi.mock('./claudeRequestGuards', () => ({
  assertValidOptionalAnthropicBaseUrl: vi.fn()
}))

const mockSend = vi.fn()
const mockPushExposure = vi.hoisted(() => vi.fn(async (_lane: string) => undefined))

vi.mock('./ipc/ipcShared', async (importOriginal) => ({
  ...await importOriginal<typeof import('./ipc/ipcShared')>(),
  makePushExposureToolsChanged: () => mockPushExposure
}))

vi.mock('./windowRef', () => ({
  getMainWindow: vi.fn(() => ({ webContents: { send: mockSend } }))
}))

const { mockSetOverride, mockRecordSettingsChange } = vi.hoisted(() => ({ mockSetOverride: vi.fn(), mockRecordSettingsChange: vi.fn() }))

vi.mock('./confirmation/policyRuleStore', () => ({
  PolicyRuleStore: class {
    listOverrides() {
      return []
    }
    getOverride() {
      return null
    }
    setOverride = mockSetOverride
  }
}))

vi.mock('./confirmation/settingsAudit', () => ({
  recordSettingsChange: mockRecordSettingsChange
}))

// The exposure notification test uses an intentionally minimal AppDatabase
// fixture. Skip the unrelated persistent IM model migration that requires a
// real SQLite connection before the config readers can produce exposure data.
vi.mock('./remote/remoteImModelConfigDb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./remote/remoteImModelConfigDb')>()),
  ensureRemoteImModelConfigMigrated: vi.fn()
}))

vi.mock('./confirmation/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./confirmation/audit')>()),
  getSecurityAuditLog: vi.fn(() => ({ record: vi.fn() }))
}))

vi.mock('./toolsConfigRuntime', () => ({
  exposedToolNamesForLane: vi.fn(() => ['read_file'])
  ,isToolEnabledByConfig: (name: string, cfg: typeof DEFAULT_TOOLS_CONFIG) =>
    cfg.enabled && !cfg.deniedTools.includes(name) && (cfg.allowedTools.length === 0 || cfg.allowedTools.includes(name))
}))

const mockReadDisabledIds = vi.fn((): string[] => [])
const mockWriteDisabledIds = vi.fn()

vi.mock('./confirmation/policyRulesRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./confirmation/policyRulesRuntime')>()
  return {
    ...actual,
    readDisabledPolicyRuleIds: () => mockReadDisabledIds(),
    writeDisabledPolicyRuleIds: (...args: unknown[]) => mockWriteDisabledIds(...args),
    loadEffectivePolicyRules: vi.fn(() => []),
    readSecurityAuditRetentionDays: vi.fn(() => 30)
  }
})

const mockIpcMain = () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
    getHandler: (channel: string) => handlers.get(channel)
  }
}

function makeWorkDirManager(): AppIpcContext['workDirManager'] {
  return {
    listProfiles: () => [],
    addProfile: vi.fn().mockReturnValue({ success: true }),
    updateProfile: vi.fn().mockReturnValue({ success: true }),
    removeProfile: vi.fn().mockReturnValue({ success: true }),
    switchProfile: vi.fn().mockResolvedValue({ success: true, sessions: [] }),
    getActiveProfile: () => undefined,
    getActiveWorkDir: () => WORK_DIR,
    getActiveProfileId: () => 'default',
    validateProfilesForSave: () => ({ valid: true }),
    validateProfileInput: () => ({ valid: true }),
    checkDirectoryWritable: () => ({ ok: true }),
    migrateFromLegacy: vi.fn(),
    persistProfiles: vi.fn()
  }
}

function makeCtx(): AppIpcContext {
  return {
    db: TEST_DB,
    backup: {
      schedule: vi.fn(),
      flush: vi.fn(),
      backupImmediate: vi.fn(),
      deleteBackup: vi.fn()
    } as unknown as AppIpcContext['backup'],
    workDirManager: makeWorkDirManager(),
    getWorkDir: () => WORK_DIR,
    setWorkDir: vi.fn(),
    getUserDataPath: () => '/fake/userdata',
    getApiKey: vi.fn().mockResolvedValue(null),
    setApiKey: vi.fn(),
    getBrowserDetectContext: () => ({
      isPackaged: false,
      appPath: '/fake/app',
      devRoot: '/fake/project'
    })
  }
}

// P8:显式装配含真 builtin registry 的默认 runtime(兼容转发打到真实注册表)
const policyAuthorizationChanges = new PolicyAuthorizationChangeRegistry()
setDefaultAgentRuntime(
  createAgentRuntime({
    confirmIds: new ConfirmIdSpace(),
    chatCancels: new ChatCancelRegistry(),
    toolRevocations: new ToolRevocationRegistry(),
    policyAuthorizationChanges,
    mcpGate: new McpConcurrencyGate(),
    builtinRegistry: createBuiltinToolRegistry()
  })
)

const registerAppIpcHandlers: typeof registerAppIpcHandlersRaw = (ipc, ctx) =>
  registerAppIpcHandlersRaw(ipc, withSessionRuntime(ctx))

describe('legacy desktop rule toggle removal', () => {
  let ipc: ReturnType<typeof mockIpcMain>

  beforeEach(() => {
    vi.clearAllMocks()
    mockPushExposure.mockClear()
    mockReadDisabledIds.mockReturnValue([])
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, makeCtx())
  })

  it('does not register the old security:set-rule-enabled channel', () => {
    expect(ipc.getHandler('security:set-rule-enabled')).toBeUndefined()
  })

  it.each([
    { name: 'deniedTools', tools: { deniedTools: ['list_work_dirs'] } },
    { name: 'enabled=false', tools: { enabled: false } }
  ])('全局工具配置变更会撤销远程专属工具（$name）', async ({ tools }) => {
    registerToolRevocationRequest('desktop-request', 'desktop', 'desktop-request')
    registerToolRevocationRequest('feishu-request', 'feishu', 'feishu-request')
    registerToolRevocationRequest('wechat-request', 'wechat', 'wechat-request')
    registerToolRevocationRequest('automation-request', 'automation', 'automation-request')
    try {
      await ipc.getHandler('config:set')?.(null, { tools })
      expect(isToolRevoked('desktop-request', 'list_work_dirs')).toBe(true)
      expect(isToolRevoked('feishu-request', 'list_work_dirs')).toBe(true)
      expect(isToolRevoked('wechat-request', 'list_work_dirs')).toBe(true)
      expect(isToolRevoked('automation-request', 'list_work_dirs')).toBe(true)
    } finally {
      clearToolRevocationRequest('desktop-request')
      clearToolRevocationRequest('feishu-request')
      clearToolRevocationRequest('wechat-request')
      clearToolRevocationRequest('automation-request')
    }
  })
})

describe('security:set-rule-override / set-policy-package：B2 动作域与档位可用性按 lane（IPC 层）', () => {
  let ipc: ReturnType<typeof mockIpcMain>

  beforeEach(() => {
    vi.clearAllMocks()
    mockReadDisabledIds.mockReturnValue([])
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, makeCtx())
  })

  it('wechat lane 提交 auto-evaluator 覆盖被拒（3 态动作域，IPC 层 B2）', async () => {
    const handler = ipc.getHandler('security:set-rule-override')!
    const res = (await handler(null, { ruleId: 'mcp-tool-ask', action: 'auto-evaluator', lane: 'wechat' })) as {
      ok: boolean
      error?: string
    }
    expect(res.ok).toBe(false)
    expect(mockSetOverride).not.toHaveBeenCalled()
  })

  it('desktop rule write rejects a missing expected revision before persistence', async () => {
    const handler = ipc.getHandler('security:set-rule-override')!
    const res = (await handler(null, { ruleId: 'mcp-tool-ask', action: 'auto-evaluator', lane: 'desktop' })) as {
      ok: boolean
    }
    expect(res).toMatchObject({ ok: false, error: 'POLICY_REVISION_INVALID' })
    expect(mockSetOverride).not.toHaveBeenCalled()
  })

  it('automation lane 提交 loose 套餐被拒（仅提供 standard，§2.1）', async () => {
    const handler = ipc.getHandler('security:set-policy-package')!
    const res = (await handler(null, { lane: 'automation', package: 'loose' })) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
  })
})
