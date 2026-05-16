import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { flushAgentLogger, initAgentLogger, logAgentEvent, resetAgentLoggerForTests } from './agentLogger'
import { formatAgentLogFileName } from './agentLogPaths'

describe('agentLogger', () => {
  let tempDir = ''

  afterEach(async () => {
    resetAgentLoggerForTests()
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true })
      tempDir = ''
    }
  })

  it('writes JSON lines to daily log file', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-log-'))
    initAgentLogger({
      getWorkDir: () => tempDir,
      isPackaged: true,
      mainDirname: tempDir
    })

    logAgentEvent('info', 'agent.startup', { workDir: tempDir })
    await flushAgentLogger()

    const logFile = path.join(tempDir, '.agent', 'logs', formatAgentLogFileName(new Date()))
    const content = await fs.readFile(logFile, 'utf8')
    const line = JSON.parse(content.trim()) as Record<string, unknown>
    expect(line.event).toBe('agent.startup')
    expect(line.level).toBe('info')
    expect(line.workDir).toBe(tempDir)
  })
})
