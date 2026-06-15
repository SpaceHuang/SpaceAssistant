import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'
import type { AppDatabase } from '../database'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { buildFeishuRemoteSystemAppendix } from '../../src/shared/feishuPrompts'

const mockRunToolChatSession = vi.fn()
const mockReadAppLocale = vi.fn<[], 'zh-CN' | 'en-US'>(() => 'en-US')
const mockGetMessages = vi.fn(() => [])

vi.mock('../toolChatLoop', () => ({
  runToolChatSession: (...args: unknown[]) => mockRunToolChatSession(...args)
}))

vi.mock('../appIpc', () => ({
  readAppLocale: (...args: unknown[]) => mockReadAppLocale(...args)
}))

vi.mock('../database', () => ({
  getMessages: (...args: unknown[]) => mockGetMessages(...args)
}))

vi.mock('./feishuCliLogger', () => ({
  logFeishuCliEvent: vi.fn()
}))

vi.mock('./runningRemoteAgentRegistry', () => ({
  registerRunningRemoteAgent: vi.fn(),
  unregisterRunningRemoteAgent: vi.fn()
}))

import { runFeishuRemoteAgent } from './feishuRemoteAgent'

function makeDb(): AppDatabase {
  return {
    data: {
      configs: { 'config.locale': { value: 'en-US', createdAt: 0, updatedAt: 0 } },
      sessions: [{ id: 'sess-1', name: '', model: 'claude-sonnet-4-20250514' }],
      messages: []
    },
    save: vi.fn()
  } as unknown as AppDatabase
}

function baseCtx(getMainWebContents: () => WebContents | null) {
  return {
    db: makeDb(),
    sessionId: 'sess-1',
    userMessage: 'hello',
    replyMessageId: 'msg-1',
    requestId: '00000000-0000-4000-8000-000000000001',
    feishuConfig: { remoteConfirmPolicy: 'always' as const, enabled: true },
    workDir: '/tmp',
    userDataDir: '/tmp',
    getMainWebContents,
    getApiKey: async () => 'key',
    getBaseUrl: () => 'https://api.example.com',
    getModel: () => 'claude-sonnet-4-20250514',
    runner: {} as never,
    confirmManager: {} as never,
    getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
    remoteContext: { source: 'feishu' as const, messageId: 'msg-1', larkCliRunner: {} as never }
  }
}

describe('runFeishuRemoteAgent locale', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadAppLocale.mockReturnValue('en-US')
    mockRunToolChatSession.mockResolvedValue({
      ok: true,
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn'
    })
  })

  it('I8: invokes runToolChatSession with appDb and raw feishu appendix (locale injected in tool loop)', async () => {
    let capturedSystem: string | undefined
    mockRunToolChatSession.mockImplementation(async (args: { system?: string; appDb?: unknown; locale?: unknown }) => {
      capturedSystem = args.system
      expect(args.appDb).toBeDefined()
      expect(args.locale).toBeUndefined()
      return { ok: true, content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }
    })

    const sender = { send: vi.fn() } as unknown as WebContents
    await runFeishuRemoteAgent(baseCtx(() => sender))

    expect(mockRunToolChatSession).toHaveBeenCalledTimes(1)
    expect(capturedSystem).toContain('feishu_remote_command')
  })

  it('I9: getMainWebContents null still invokes runToolChatSession with appDb', async () => {
    await runFeishuRemoteAgent(baseCtx(() => null))

    expect(mockRunToolChatSession).toHaveBeenCalledWith(
      expect.objectContaining({ appDb: expect.anything() })
    )
  })

  it('I10: feishu appendix is passed as base system before locale injection in tool loop', async () => {
    const appendix = buildFeishuRemoteSystemAppendix({
      messageId: 'msg-1',
      confirmPolicy: 'always',
      browserRemoteHint: undefined
    })

    mockRunToolChatSession.mockImplementation(async (args: { system?: string }) => {
      const finalWithLocale = `${args.system ?? ''}\n\n<ui_locale_preference>\nEnglish\n</ui_locale_preference>`
      expect(finalWithLocale.indexOf(appendix.slice(0, 20))).toBeLessThan(
        finalWithLocale.indexOf('<ui_locale_preference>')
      )
      return { ok: true, content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }
    })

    await runFeishuRemoteAgent(baseCtx(() => null))
    expect(mockRunToolChatSession).toHaveBeenCalledWith(expect.objectContaining({ system: appendix }))
  })
})
