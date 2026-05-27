import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  flushFeishuCliLogger,
  initFeishuCliLogger,
  logFeishuCliEvent,
  resetFeishuCliLoggerForTests
} from './feishuCliLogger'
import { formatFeishuCliLogFileName } from './feishuCliLogPaths'

describe('feishuCliLogger', () => {
  let tempDir = ''

  afterEach(async () => {
    resetFeishuCliLoggerForTests()
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true })
      tempDir = ''
    }
  })

  it('writes startup and custom events with redacted content', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-cli-log-'))
    initFeishuCliLogger({
      getWorkDir: () => tempDir,
      isPackaged: true,
      mainDirname: tempDir
    })

    logFeishuCliEvent('info', 'feishu.inbound.accept', {
      content: '用户机密消息正文',
      secret: 'top-secret'
    })
    await flushFeishuCliLogger()

    const logFile = path.join(tempDir, '.agent', 'logs', formatFeishuCliLogFileName(new Date()))
    const lines = (await fs.readFile(logFile, 'utf8')).trim().split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(2)

    const acceptLine = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>
    expect(acceptLine.event).toBe('feishu.inbound.accept')
    expect(acceptLine.content).toBeUndefined()
    expect(acceptLine.contentLen).toBe(8)
    expect(acceptLine.contentHash).toMatch(/^[0-9a-f]{8}$/)
    expect(acceptLine.secret).toBe('[REDACTED]')
  })
})
