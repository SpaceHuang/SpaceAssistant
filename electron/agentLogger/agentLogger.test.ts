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

  it('target tool events drop raw process input and output', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-log-safe-'))
    initAgentLogger({ getWorkDir: () => tempDir, isPackaged: true, mainDirname: tempDir })
    logAgentEvent('error', 'tool.error', {
      toolName: 'run_script',
      input: { code: 'print("token=raw-secret")', cwd: '/Users/Alice/private' },
      error: 'spawn failed at /usr/bin/python',
      stdout: 'password=raw-secret'
    })
    await flushAgentLogger()
    const logFile = path.join(tempDir, '.agent', 'logs', formatAgentLogFileName(new Date()))
    const content = await fs.readFile(logFile, 'utf8')
    expect(content).not.toContain('raw-secret')
    expect(content).not.toContain('/Users/Alice')
    expect(content).not.toContain('/usr/bin/python')
    expect(content).toContain('inputFingerprint')
    expect(content).toContain('errorRedacted')
  })

  it('tool.request does not persist run_script source code', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-log-request-safe-'))
    initAgentLogger({ getWorkDir: () => tempDir, isPackaged: true, mainDirname: tempDir })
    logAgentEvent('info', 'tool.request', {
      toolName: 'run_script',
      input: { code: 'print("connection=postgres://user:secret@host/db")' }
    })
    await flushAgentLogger()
    const logFile = path.join(tempDir, '.agent', 'logs', formatAgentLogFileName(new Date()))
    const content = await fs.readFile(logFile, 'utf8')
    expect(content).not.toContain('postgres://user:secret')
    expect(content).not.toContain('print(')
    expect(content).toContain('inputFingerprint')
  })

  it('trust.remove does not persist shell command text', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-log-trust-safe-'))
    initAgentLogger({ getWorkDir: () => tempDir, isPackaged: true, mainDirname: tempDir })
    logAgentEvent('info', 'trust.remove', {
      type: 'shell_command',
      item: '/Users/Alice/private token command --password=raw-secret'
    })
    await flushAgentLogger()
    const logFile = path.join(tempDir, '.agent', 'logs', formatAgentLogFileName(new Date()))
    const content = await fs.readFile(logFile, 'utf8')
    expect(content).not.toContain('private token command')
    expect(content).not.toContain('raw-secret')
    expect(content).toContain('itemFingerprint')
  })
})
