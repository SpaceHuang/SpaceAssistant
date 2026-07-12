import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  flushWeChatCliLogger,
  initWeChatCliLogger,
  logWeChatCliEvent,
  resetWeChatCliLoggerForTests
} from './weChatCliLogger'
import { formatWeChatCliLogFileName } from './weChatCliLogPaths'

describe('weChatCliLogger', () => {
  let tempDir = ''

  afterEach(async () => {
    resetWeChatCliLoggerForTests()
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true })
      tempDir = ''
    }
  })

  it('writes startup and custom events with redacted content', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-cli-log-'))
    initWeChatCliLogger({
      getWorkDir: () => tempDir,
      isPackaged: true,
      mainDirname: tempDir
    })

    logWeChatCliEvent('info', 'wechat.inbound.accept', {
      text: '用户机密消息正文',
      token: 'bot-token-secret'
    })
    await flushWeChatCliLogger()

    const logFile = path.join(tempDir, '.agent', 'logs', formatWeChatCliLogFileName(new Date()))
    const lines = (await fs.readFile(logFile, 'utf8')).trim().split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(2)

    const acceptLine = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>
    expect(acceptLine.event).toBe('wechat.inbound.accept')
    expect(acceptLine.text).toBeUndefined()
    expect(acceptLine.textLen).toBe(8)
    expect(acceptLine.textHash).toMatch(/^[0-9a-f]{8}$/)
    expect(acceptLine.token).toBeUndefined()
  })
})
