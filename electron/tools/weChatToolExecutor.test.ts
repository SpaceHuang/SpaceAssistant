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
