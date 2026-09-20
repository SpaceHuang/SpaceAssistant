import fs from 'fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as agentLoggerModule from '../agentLogger/agentLogger'
import { formatAgentLogDateKey, formatAgentLogFileName } from '../agentLogger/agentLogPaths'
import { pruneAgentLogs } from './agentLogRetention'

/**
 * S3(偏差 14):Agent 日志保留期清理挂接统一保留策略——
 * 按日文件天然轮转(Agent-YYYYMMDD.log),此处补「超保留期删除 + 删除留痕」。
 */

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(agentLoggerModule, 'logAgentEvent').mockImplementation(() => undefined)
})

afterEach(() => {
  warnSpy.mockRestore()
})

async function makeLogDir(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-log-retention-'))
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, 'utf8')
  }
  return dir
}

describe('agentLogRetention(偏差 14:日志保留期归位 Storage)', () => {
  it('删除超保留期的按日日志,保留期内与当日日志不动;无关文件不删', async () => {
    const now = new Date('2026-09-20T12:00:00+08:00')
    const dir = await makeLogDir({
      [formatAgentLogFileName(new Date('2026-01-01T00:00:00Z'))]: 'old',
      [formatAgentLogFileName(new Date('2026-09-19T00:00:00Z'))]: 'recent',
      [formatAgentLogFileName(now)]: 'today',
      'not-a-log.txt': 'keep'
    })
    const result = await pruneAgentLogs({ logDir: dir, retentionDays: 30, now })
    expect(result.removed).toBe(1)
    expect(result.removedFiles).toEqual([formatAgentLogFileName(new Date('2026-01-01T00:00:00Z'))])
    await expect(fs.stat(path.join(dir, formatAgentLogFileName(new Date('2026-09-19T00:00:00Z'))))).toBeTruthy()
    await expect(fs.stat(path.join(dir, formatAgentLogFileName(now)))).toBeTruthy()
    await expect(fs.stat(path.join(dir, 'not-a-log.txt'))).toBeTruthy()
  })

  it('删除留痕:removed > 0 时落 retention.agentLogs.cleaned(策略 + 名单 + 数量)', async () => {
    const now = new Date('2026-09-20T12:00:00+08:00')
    const stale = formatAgentLogFileName(new Date('2026-01-01T00:00:00Z'))
    const dir = await makeLogDir({ [stale]: 'old' })
    warnSpy.mockClear()
    await pruneAgentLogs({ logDir: dir, retentionDays: 30, now })
    expect(warnSpy).toHaveBeenCalledWith(
      'info',
      'retention.agentLogs.cleaned',
      expect.objectContaining({
        strategy: 'retentionDays',
        retentionDays: 30,
        removed: 1,
        removedFiles: [stale]
      })
    )
  })

  it('retentionDays < 1(fail-closed)不删任何文件', async () => {
    const now = new Date('2026-09-20T12:00:00+08:00')
    const dir = await makeLogDir({ [formatAgentLogFileName(new Date('2026-01-01T00:00:00Z'))]: 'old' })
    const result = await pruneAgentLogs({ logDir: dir, retentionDays: 0, now })
    expect(result.removed).toBe(0)
    await expect(fs.stat(path.join(dir, formatAgentLogFileName(new Date('2026-01-01T00:00:00Z'))))).toBeTruthy()
  })

  it('日志目录不存在安全返回', async () => {
    const result = await pruneAgentLogs({
      logDir: path.join(os.tmpdir(), 'agent-log-retention-absent', formatAgentLogDateKey(new Date())),
      retentionDays: 30,
      now: new Date()
    })
    expect(result.removed).toBe(0)
  })
})
