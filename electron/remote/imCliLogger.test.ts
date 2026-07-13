import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatAgentLogDateKey } from '../agentLogger/agentLogPaths'
import { createImCliLogger } from './imCliLogger'

describe('imCliLogger', () => {
  let tempDir = ''

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true })
      tempDir = ''
    }
  })

  it('writes startup and custom events with preprocessed fields', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'im-cli-log-'))
    const logger = createImCliLogger({
      channel: 'feishu',
      logFileNamePrefix: 'FeishuCli',
      preprocessFields: (fields) => {
        if (typeof fields.content === 'string') {
          return { contentLen: fields.content.length }
        }
        return fields
      }
    })

    logger.init({
      getWorkDir: () => tempDir,
      isPackaged: true,
      mainDirname: tempDir
    })

    logger.logEvent('info', 'feishu.inbound.accept', { content: 'secret body' })
    await logger.flush()

    const logFile = path.join(
      tempDir,
      '.agent',
      'logs',
      `FeishuCli-${formatAgentLogDateKey(new Date())}.log`
    )
    const lines = (await fs.readFile(logFile, 'utf8')).trim().split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(2)

    const acceptLine = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>
    expect(acceptLine.event).toBe('feishu.inbound.accept')
    expect(acceptLine.contentLen).toBe(11)
    expect(acceptLine.content).toBeUndefined()
  })
})
