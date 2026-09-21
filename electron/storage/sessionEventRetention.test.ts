import fs from 'fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as agentLoggerModule from '../agentLogger/agentLogger'
import { SessionEventWriter } from '../sessionEvents'
import {
  enforceSessionEventRetention,
  enforceSessionEventRetentionDetailed
} from './sessionEventRetention'

/**
 * S3(偏差 24):会话事件台账保留期从 sessionEvents.ts(Core 文件)归位 Storage——
 * 本文件自 sessionEvents.test.ts 搬入,消费口改 electron/storage/sessionEventRetention,
 * 并新增「删除留痕」验收(删了什么、多少个、依据哪条策略)。
 */

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(agentLoggerModule, 'logAgentEvent').mockImplementation(() => undefined)
})

afterEach(() => {
  warnSpy.mockRestore()
})

describe('sessionEventRetention(归位 Storage,偏差 24)', () => {
  it('retains the newest event sessions by index timestamp', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-'))
    for (const [id, time] of [['old', 1], ['new', 2]] as const) {
      const writer = new SessionEventWriter(root, id, time)
      await writer.append({ type: 'session_end_seed', payload: { seedSeq: 0 } })
      await fs.writeFile(writer.indexPath, JSON.stringify({ seq: 1, lastAt: time, eventCount: 1, bytes: 1 }))
    }
    expect(await enforceSessionEventRetention(root, 1)).toBe(1)
    expect(await fs.stat(path.join(root, 'sessions', 'new-19700101'))).toBeTruthy()
    await expect(fs.stat(path.join(root, 'sessions', 'old-19700101'))).rejects.toThrow()
  })

  it('isolates retention deletion failure and continues the retention pass', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-failure-'))
    for (const [id, time] of [['oldest', 1], ['middle', 2], ['newest', 3]] as const) {
      const dir = path.join(root, 'sessions', `${id}-19700101`)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'events.index.json'), JSON.stringify({ lastAt: time }))
    }
    const originalRm = fs.rm
    const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (target === path.join(root, 'sessions', 'oldest-19700101')) throw new Error('retention delete failed')
      return originalRm(target, options)
    })

    const result = await enforceSessionEventRetentionDetailed(root, 1)
    expect(result.removed).toBe(1)
    expect(result.failures).toMatchObject([{ sessionName: 'oldest-19700101', phase: 'retention-delete' }])
    await expect(fs.stat(path.join(root, 'sessions', 'middle-19700101'))).rejects.toThrow()
    expect(await fs.stat(path.join(root, 'sessions', 'newest-19700101'))).toBeTruthy()
    rmSpy.mockRestore()
  })

  it('删除留痕:removed > 0 时落 retention.sessionEvents.cleaned(策略 + 名单 + 数量)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-audit-'))
    for (const [id, time] of [['old', 1], ['new', 2]] as const) {
      const dir = path.join(root, 'sessions', `${id}-19700101`)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'events.index.json'), JSON.stringify({ lastAt: time }))
    }
    warnSpy.mockClear()
    await enforceSessionEventRetentionDetailed(root, 1)
    expect(warnSpy).toHaveBeenCalledWith(
      'info',
      'retention.sessionEvents.cleaned',
      expect.objectContaining({
        strategy: 'maxSessions',
        maxSessions: 1,
        removed: 1,
        removedSessions: ['old-19700101']
      })
    )
  })

  it('无删除不落清理审计', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-clean-'))
    warnSpy.mockClear()
    await enforceSessionEventRetentionDetailed(root, 3)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
