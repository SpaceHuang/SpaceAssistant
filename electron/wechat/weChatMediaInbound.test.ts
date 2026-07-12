import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createMockWeChatBot } from './__mocks__/wechatBotMock'
import { downloadWeChatInboundMedia, buildMediaUserMessage } from './weChatMediaInbound'
import { makeIncomingMessage } from './__mocks__/wechatBotMock'

describe('weChatMediaInbound', () => {
  let workDir: string

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-media-'))
  })

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true })
  })

  it('downloads image to .wechat-inbound', async () => {
    const bot = createMockWeChatBot()
    const raw = makeIncomingMessage({ type: 'image', text: 'caption' })
    const result = await downloadWeChatInboundMedia(bot, raw, workDir)
    expect(result?.relativePath).toMatch(/^\.wechat-inbound\//)
    const abs = path.join(workDir, result!.relativePath)
    const stat = await fs.stat(abs)
    expect(stat.size).toBeGreaterThan(0)
  })

  it('builds user message with caption', () => {
    const msg = {
      messageId: 'm1',
      userId: 'u1',
      text: '说明文字',
      type: 'image' as const,
      timestamp: new Date().toISOString(),
      contextToken: 'ctx'
    }
    const text = buildMediaUserMessage(msg, {
      localPath: '/tmp/x.jpg',
      relativePath: '.wechat-inbound/x.jpg',
      fileName: 'x.jpg'
    })
    expect(text).toContain('.wechat-inbound/x.jpg')
    expect(text).toContain('说明文字')
  })
})
