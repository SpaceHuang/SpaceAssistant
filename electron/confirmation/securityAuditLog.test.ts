import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { SecurityAuditLog, auditLine, sanitizeAuditField } from './securityAuditLog'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'

const tmpDirs: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-audit-'))
  tmpDirs.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true })
  }
})

function baseEvent(): SecurityAuditEvent {
  return {
    ts: Date.now(),
    event: 'policy.decision',
    lane: 'desktop',
    sessionId: 's1',
    toolName: 'run_shell',
    actionClass: 'execute',
    riskLevel: 'high',
    decision: 'require-confirm',
    ruleId: 'default-write-execute-ask',
    actor: 'system'
  }
}

describe('安全审计日志：脱敏', () => {
  it('不落 token / secret / API Key 形态内容', () => {
    const line = auditLine({
      ...baseEvent(),
      factsSummary: '命令 sk-helloworld123 已执行，secret=abc api_key=xyz'
    })
    expect(line).not.toContain('sk-helloworld123')
    expect(line).not.toContain('secret=abc')
    expect(line).not.toContain('api_key=xyz')
  })

  it('sanitizeAuditField 保留普通文本', () => {
    expect(sanitizeAuditField('ping baidu.com')).toBe('ping baidu.com')
  })
})

describe('安全审计日志：独立文件 + JSON Lines 落盘', () => {
  it('record + flush 写入 SecurityAudit-{date}.log', async () => {
    const dir = await tmpDir()
    const log = new SecurityAuditLog({ logDir: dir })
    log.record(baseEvent())
    await log.flush()
    const files = await fs.readdir(dir)
    expect(files.some((f) => /^SecurityAudit-\d{8}\.log$/.test(f))).toBe(true)
    const content = await fs.readFile(path.join(dir, files[0]!), 'utf8')
    const parsed = JSON.parse(content.trim().split('\n')[0]!)
    expect(parsed.event).toBe('policy.decision')
    expect(parsed.sessionId).toBe('s1')
  })
})

describe('安全审计日志：故障不阻断', () => {
  it('写失败时 flush 仍正常返回，事件保留在缓冲（B3）', async () => {
    // logDir 指向一个普通文件，appendFile 必然失败
    const dir = await tmpDir()
    const filePath = path.join(dir, 'block')
    await fs.writeFile(filePath, 'x')
    const log = new SecurityAuditLog({ logDir: filePath })
    log.record(baseEvent())
    await expect(log.flush()).resolves.toBeUndefined()
    // 事件未静默丢失（仍留在缓冲），后续可再次尝试
    await expect(log.flush()).resolves.toBeUndefined()
  })

  it('写失败后恢复目录可写，事件最终落盘（重试不静默丢弃）', async () => {
    const base = await tmpDir()
    const block = path.join(base, 'block')
    await fs.writeFile(block, 'x')
    const log = new SecurityAuditLog({ logDir: block })
    log.record(baseEvent())
    await log.flush() // 写失败 → 事件保留
    await fs.rm(block, { force: true }) // 恢复：移除阻塞文件
    await log.flush() // 重试成功
    const files = await fs.readdir(block)
    expect(files.some((f) => /^SecurityAudit-\d{8}\.log$/.test(f))).toBe(true)
  })
})
