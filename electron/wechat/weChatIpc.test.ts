import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain } from 'electron'
import { mergeToolsConfig } from '../../src/shared/domainTypes'
import type { ConfirmRequest } from '../../src/shared/confirmation/types'
import { createMemoryAppDb } from '../database/testHelpers'
import { getWeChatBundle, registerWeChatIpcHandlers, shutdownWeChatServices } from './weChatIpc'
import { WeChatImChannel } from './weChatImChannel'

const request: ConfirmRequest = {
  facts: { toolName: 'write_file', actionClass: 'write', baseRiskLevel: 'medium', signals: [], summary: { text: 'write file' } },
  riskLevel: 'medium', memoryTiers: [], timeoutMs: null
}

describe('wechat:confirm-response main-process IPC baseline', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined
  let userDataDir: string | undefined

  afterEach(async () => {
    getWeChatBundle()?.imChannel.cancelAllPending()
    await shutdownWeChatServices()
    db?.close()
    db = undefined
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
    userDataDir = undefined
  })

  it('desktop IPC refuses a pending IM confirmation without consuming or resolving it', async () => {
    db = createMemoryAppDb()
    userDataDir = mkdtempSync(path.join(os.tmpdir(), 'wechat-ipc-confirm-'))
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const ipcMain = { handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler) } as unknown as IpcMain
    mkdirSync(path.join(userDataDir, 'logs'), { recursive: true })
    registerWeChatIpcHandlers(ipcMain, {
      db,
      getUserDataPath: () => userDataDir!,
      getWorkDir: () => userDataDir!,
      workDirManager: {} as never,
      getApiKey: async () => null,
      getBaseUrl: () => 'https://example.invalid',
      getModel: () => 'test-model',
      getMaxParallel: () => 1,
      getToolsConfig: () => mergeToolsConfig({}),
      appVersion: 'test'
    })
    const bundle = getWeChatBundle()
    expect(bundle).not.toBeNull()
    vi.spyOn(bundle!.auditLogger, 'append').mockResolvedValue()
    const imChannel = new WeChatImChannel({ getReplyBot: () => ({
      sendToUser: async () => ({ messageId: 'wechat-prompt-1' }),
      reply: async () => ({ messageId: 'wechat-hint-1' })
    } as never) })
    bundle!.imChannel.cancelAllPending()
    bundle!.imChannel = imChannel

    const outcome = imChannel.request(request, {
      sessionId: 'im-session', toolName: 'write_file', messageId: 'inbound-message', matchKey: 'wx-owner', authOwner: 'wx-owner',
      context: { userId: 'wx-owner', timestamp: new Date(), raw: { client_id: 'wechat-client' } } as never,
      requestId: 'im-request-1', authorizationGeneration: 1
    })
    await vi.waitFor(() => expect(imChannel.listPending()).toHaveLength(1))
    const pending = imChannel.listPending()[0]!
    const handler = handlers.get('wechat:confirm-response')
    expect(handler).toBeTypeOf('function')

    await expect(handler!({}, { requestId: pending.id, approved: true })).resolves.toMatchObject({ ok: false })
    expect(await Promise.race([outcome.then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('pending'), 0))])).toBe('pending')
    expect(imChannel.listPending()).toHaveLength(1)
    imChannel.tryResolveFromInboundMessage({ userId: 'wx-owner', messageId: 'wechat-answer', quotedMessageId: 'wechat-prompt-1', text: `Y ${pending.confirmId}` }, { allowedUserIds: ['wx-owner'] })
    await expect(outcome).resolves.toMatchObject({ kind: 'approved', cause: 'user-approved' })
    expect(imChannel.listPending()).toHaveLength(0)
  })
})
