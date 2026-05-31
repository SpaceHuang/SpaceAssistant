import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn()
}))

import { logAgentEvent } from './agentLogger/agentLogger'
import { canSkipShellConfirm } from './shell/analyzeShellCommand'
import { precheckRunShellTool, logShellSecurityDeny } from './shell/shellToolLoopHelpers'

describe('toolChatLoop shell integration helpers', () => {
  let workDir: string

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-shell-loop-'))
    vi.mocked(logAgentEvent).mockClear()
  })

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true })
  })

  it('denies sudo without confirm path', async () => {
    const result = await precheckRunShellTool({
      command: 'sudo rm -rf /',
      workDir,
      userDataDir: workDir
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/提权|sudo|拒绝|规则/)
    }
  })

  it('allows skip confirm for allow rule on safe command', async () => {
    const result = await precheckRunShellTool({
      command: 'git status',
      workDir,
      userDataDir: workDir,
      shellConfig: {
        enabled: true,
        shellDefaultTimeoutSec: 300,
        maxInlineOutputBytes: 102400,
        rules: [{ id: '1', pattern: 'git status', decision: 'allow' }]
      }
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.skipConfirm).toBe(true)
      expect(canSkipShellConfirm(result.analysis)).toBe(true)
    }
  })

  it('does not skip confirm when requiresRiskAck', async () => {
    const result = await precheckRunShellTool({
      command: 'cat ../../../etc/passwd',
      workDir,
      userDataDir: workDir,
      shellConfig: {
        enabled: true,
        shellDefaultTimeoutSec: 300,
        maxInlineOutputBytes: 102400,
        rules: [{ id: '1', pattern: 'cat *', decision: 'allow' }]
      }
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.skipConfirm).toBe(false)
      expect(result.hints.requiresRiskAck).toBe(true)
    }
  })

  it('logShellSecurityDeny writes audit event', () => {
    logShellSecurityDeny({
      requestId: 'r1',
      sessionId: 's1',
      command: 'sudo x',
      reason: 'security_deny'
    })
    expect(logAgentEvent).toHaveBeenCalledWith(
      'info',
      'shell.security.deny',
      expect.objectContaining({ reason: 'security_deny' })
    )
  })
})
