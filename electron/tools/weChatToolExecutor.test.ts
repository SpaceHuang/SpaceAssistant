import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createMockWeChatBot } from '../wechat/__mocks__/wechatBotMock'
import { DEFAULT_WECHAT_CONFIG } from '../../src/shared/wechatTypes'

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

  it('拒绝工作目录内指向外部的附件 symlink，并返回机制诊断', async () => {
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
