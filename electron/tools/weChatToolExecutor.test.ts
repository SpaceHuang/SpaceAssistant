import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createMockWeChatBot } from '../wechat/__mocks__/wechatBotMock'
import { DEFAULT_WECHAT_CONFIG } from '../../src/shared/wechatTypes'
import { canCreateSymlinks } from '../../src/test/symlinkCapability'

vi.mock('../wechat/weChatIpc', () => ({
  getWeChatBundle: () => null
}))

import { executeWeChatSend } from './weChatToolExecutor'

describe('executeWeChatSend', () => {
  let workDir: string
  const mockBot = createMockWeChatBot()

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-tool-'))
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true })
  })

  it('rejects when wechat disabled', async () => {
    const result = await executeWeChatSend(
      { userId: 'u1', text: 'hi' },
      {
        workDir,
        botService: { getRawBot: () => mockBot } as never,
        getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: false })
      }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('未绑定')
  })

  it('rejects path outside workDir', async () => {
    const result = await executeWeChatSend(
      { userId: 'u1', text: 'hi', filePath: '../../../etc/passwd' },
      {
        workDir,
        botService: { getRawBot: () => mockBot } as never,
        getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true })
      }
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/工作目录|不存在/)
  })

  // 依赖真实 symlink 的用例以能力探测保护：win32 非特权进程 fs.symlink 直接 EPERM；安全语义由下方 mock 通路覆盖。
  it.skipIf(!canCreateSymlinks())('拒绝工作目录内指向外部的附件 symlink，并返回机制诊断', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-media-outside-'))
    const outsideFile = path.join(outsideDir, 'private.txt')
    const linkedFile = path.join(workDir, 'shared.txt')
    await fs.writeFile(outsideFile, 'private content')
    await fs.symlink(outsideFile, linkedFile)
    try {
      const result = await executeWeChatSend(
        { userId: 'u1', text: 'share', filePath: 'shared.txt' },
        {
          workDir,
          botService: { getRawBot: () => mockBot } as never,
          getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true })
        }
      )

      expect(result).toMatchObject({
        success: false,
        diagnostic: { caseId: 'wechat-media-target-outside-workdir', category: 'mechanism' }
      })
      expect(mockBot.send).not.toHaveBeenCalled()
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('mock 通路：realpath 解析到工作目录外时拒绝附件并返回机制诊断（win32 无特权平台的安全语义锚）', async () => {
    const linkAbs = path.resolve(workDir, 'shared.txt')
    const outsideReal = path.resolve(workDir, '..', 'mock-wechat-outside.txt')
    const originalRealpath = fs.realpath.bind(fs)
    const realpathSpy = vi.spyOn(fs, 'realpath').mockImplementation(async (target, ...args) => {
      if (String(target) === linkAbs) return outsideReal
      return originalRealpath(target, ...args)
    })
    try {
      const result = await executeWeChatSend(
        { userId: 'u1', text: 'share', filePath: 'shared.txt' },
        {
          workDir,
          botService: { getRawBot: () => mockBot } as never,
          getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true })
        }
      )
      expect(result).toMatchObject({
        success: false,
        diagnostic: { caseId: 'wechat-media-target-outside-workdir', category: 'mechanism' }
      })
      expect(mockBot.send).not.toHaveBeenCalled()
    } finally {
      realpathSpy.mockRestore()
    }
  })

  it('sends text when configured', async () => {
    const result = await executeWeChatSend(
      { userId: 'u1', text: 'hello' },
      {
        workDir,
        botService: { getRawBot: () => mockBot } as never,
        getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true })
      }
    )
    expect(result.success).toBe(true)
    expect(mockBot.send).toHaveBeenCalled()
  })
})
