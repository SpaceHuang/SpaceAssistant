import { describe, expect, it, vi, beforeEach } from 'vitest'
import path from 'path'
import { registerAppIpcHandlers } from './appIpc'
import type { AppIpcContext } from './appIpc'
import { isToolRevoked, registerToolRevocationRequest, clearToolRevocationRequest } from './toolRevocationRegistry'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'

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
  appendSearchHistory: vi.fn(),
  listSearchHistory: vi.fn(() => []),
  setSessionUsage: vi.fn(),
  getSessionUsage: vi.fn(),
  deleteSessionUsage: vi.fn(),
  getDbConnection: vi.fn(() => ({}))
}))

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicClient: vi.fn()
}))

vi.mock('./claudeRequestGuards', () => ({
  assertValidOptionalAnthropicBaseUrl: vi.fn()
}))

const mockSend = vi.fn()

vi.mock('./windowRef', () => ({
  getMainWindow: vi.fn(() => ({ webContents: { send: mockSend } }))
}))

const mockSetOverride = vi.fn()

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
  recordSettingsChange: vi.fn()
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
    db: { save: vi.fn(), flushSave: vi.fn() } as unknown as AppIpcContext['db'],
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

describe('security:set-rule-enabled 仅限 locked+deny 系统保护规则（fail-closed ask 不可禁用）', () => {
  let ipc: ReturnType<typeof mockIpcMain>

  beforeEach(() => {
    vi.clearAllMocks()
    mockReadDisabledIds.mockReturnValue([])
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, makeCtx())
  })

  const invoke = (payload: Record<string, unknown>) =>
    ipc.getHandler('security:set-rule-enabled')?.(null, payload) as Promise<{ ok: boolean; error?: string }>

  it('locked+deny 保护规则可切换（既有行为）', async () => {
    const r = await invoke({ ruleId: 'remote-shell-disabled', enabled: false })
    expect(r.ok).toBe(true)
    expect(mockWriteDisabledIds).toHaveBeenCalled()
  })

  it.each(['lark-high-impact-ask', 'lark-unknown-ask', 'script-uncertified-ask-remote'])(
    'fail-closed ask 规则 %s 拒绝禁用',
    async (ruleId) => {
      const r = await invoke({ ruleId, enabled: false })
      expect(r.ok).toBe(false)
      expect(mockWriteDisabledIds).not.toHaveBeenCalled()
    }
  )

  it('切换成功后重推 exposure:tools-changed（三条链路）', async () => {
    const r = await invoke({ ruleId: 'remote-shell-disabled', enabled: false })
    expect(r.ok).toBe(true)
    const pushes = mockSend.mock.calls.filter((c) => c[0] === 'exposure:tools-changed')
    expect(pushes.map((c) => (c[1] as { lane: string }).lane).sort()).toEqual(['desktop', 'feishu', 'wechat'])
  })

  it.each([
    { name: 'deniedTools', tools: { deniedTools: ['list_work_dirs'] } },
    { name: 'enabled=false', tools: { enabled: false } }
  ])('全局工具配置变更会撤销远程专属工具（$name）', async ({ tools }) => {
    registerToolRevocationRequest('feishu-request', 'feishu')
    registerToolRevocationRequest('wechat-request', 'wechat')
    try {
      await ipc.getHandler('config:set')?.(null, { tools })
      expect(isToolRevoked('feishu-request', 'list_work_dirs')).toBe(true)
      expect(isToolRevoked('wechat-request', 'list_work_dirs')).toBe(true)
    } finally {
      clearToolRevocationRequest('feishu-request')
      clearToolRevocationRequest('wechat-request')
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

  it('desktop lane 提交 auto-evaluator 覆盖被接受（4 态动作域）', async () => {
    const handler = ipc.getHandler('security:set-rule-override')!
    const res = (await handler(null, { ruleId: 'mcp-tool-ask', action: 'auto-evaluator', lane: 'desktop' })) as {
      ok: boolean
    }
    expect(res.ok).toBe(true)
    expect(mockSetOverride).toHaveBeenCalled()
  })

  it('automation lane 提交 loose 套餐被拒（仅提供 standard，§2.1）', async () => {
    const handler = ipc.getHandler('security:set-policy-package')!
    const res = (await handler(null, { lane: 'automation', package: 'loose' })) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
  })
})
