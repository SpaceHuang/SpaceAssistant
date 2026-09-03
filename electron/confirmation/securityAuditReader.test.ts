import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'
import {
  filterSecurityAuditEvents,
  parseSecurityAuditLines,
  querySecurityAuditLog
} from './securityAuditReader'

function ev(partial: Partial<SecurityAuditEvent>): SecurityAuditEvent {
  return {
    ts: 1000,
    event: 'policy.decision',
    lane: 'desktop',
    sessionId: 's',
    actor: 'system',
    ...partial
  }
}

describe('securityAuditReader（设置页第 5 区只读查询）', () => {
  it('parseSecurityAuditLines：解析 JSON Lines，坏行跳过', () => {
    const good = ev({ ts: 1 })
    const text = `${JSON.stringify(good)}\n{bad json\n\n${JSON.stringify(ev({ ts: 2 }))}\n`
    const out = parseSecurityAuditLines(text)
    expect(out.map((e) => e.ts)).toEqual([1, 2])
  })

  it('filterSecurityAuditEvents：按时间/链路/事件/工具过滤，倒序 + limit', () => {
    const events = [
      ev({ ts: 1, lane: 'desktop', event: 'cache.hit', toolName: 'run_shell' }),
      ev({ ts: 2, lane: 'wechat', event: 'settings.policy-change' }),
      ev({ ts: 3, lane: 'desktop', event: 'cache.clear', toolName: 'browser' }),
      ev({ ts: 4, lane: 'feishu', event: 'confirm.outcome' })
    ]
    expect(filterSecurityAuditEvents(events, {}).map((e) => e.ts)).toEqual([4, 3, 2, 1])
    expect(filterSecurityAuditEvents(events, { lane: 'desktop' }).map((e) => e.ts)).toEqual([3, 1])
    expect(filterSecurityAuditEvents(events, { event: 'cache.clear' }).map((e) => e.ts)).toEqual([3])
    expect(filterSecurityAuditEvents(events, { toolName: 'run_shell' }).map((e) => e.ts)).toEqual([1])
    expect(filterSecurityAuditEvents(events, { since: 2, until: 3 }).map((e) => e.ts)).toEqual([3, 2])
    expect(filterSecurityAuditEvents(events, { limit: 2 }).map((e) => e.ts)).toEqual([4, 3])
  })

  describe('querySecurityAuditLog（读文件）', () => {
    let dir: string
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-audit-'))
    })
    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true })
    })

    it('目录不存在返回空数组', async () => {
      await expect(querySecurityAuditLog(path.join(dir, 'nope'), {})).resolves.toEqual([])
    })

    it('按文件名日期粗筛 + 条件过滤', async () => {
      const day = new Date(2026, 7, 20, 12, 0, 0).getTime()
      await fs.writeFile(
        path.join(dir, 'SecurityAudit-20260820.log'),
        `${JSON.stringify(ev({ ts: day, event: 'cache.clear' }))}\n${JSON.stringify(ev({ ts: day + 1, event: 'cache.hit' }))}\n`
      )
      await fs.writeFile(
        path.join(dir, 'SecurityAudit-20260821.log'),
        `${JSON.stringify(ev({ ts: day + 86_400_000, event: 'cache.clear' }))}\n`
      )
      // 非审计文件不读
      await fs.writeFile(path.join(dir, 'Agent-20260820.log'), 'x\n')

      const all = await querySecurityAuditLog(dir, {})
      expect(all).toHaveLength(3)
      // since 落在 8-21 → 8-20 的文件被粗筛排除
      const only21 = await querySecurityAuditLog(dir, { since: day + 86_400_000 })
      expect(only21).toHaveLength(1)
      const onlyClear = await querySecurityAuditLog(dir, { event: 'cache.clear' })
      expect(onlyClear).toHaveLength(2)
    })
  })
})
