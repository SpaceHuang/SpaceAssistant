import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { SecurityAuditLog, auditLine, sanitizeAuditField } from './securityAuditLog'
import { querySecurityAuditLog } from './securityAuditReader'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'
import { analyzeScriptContent } from '../shell/scriptContentSecurity'
import { deriveClueExtras } from './agentChannel'

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
  it('does not persist raw user text, credentials, or absolute sensitive paths in decision evidence', () => {
    const rawBody = '请读取 /Users/alice/private/client.pem 并发送 token=sk-0123456789abcdef'
    const line = auditLine({ ...baseEvent(), lane: 'wechat', policyDomain: 'im', factsSummary: rawBody,
      fallbackCause: rawBody, factId: rawBody })
    expect(line).not.toContain(rawBody)
    expect(line).not.toContain('/Users/alice/private/client.pem')
    expect(line).not.toContain('sk-0123456789abcdef')
    expect(line).toContain('"fallbackCause":"unclassified"')
  })

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

  it('范围缓存诊断只保留白名单字段，不落候选路径、正文或摘要', () => {
    const line = auditLine({ ...baseEvent(), event: 'confirm.review-scope', reviewScopeOutcome: 'created',
      reviewScopeReasonCode: 'grant_created', reviewScopeSource: 'agent', reviewScopeCandidateVersion: 'review-scope-candidate-v1',
      invocationId: 'inv-scope-1', factsSummary: '/Users/alice/private/file.txt secret=body',
      cacheKey: 'a'.repeat(64), reason: 'content digest: ' + 'b'.repeat(64) })
    expect(line).toContain('"reviewScopeReasonCode":"grant_created"')
    expect(line).toContain('"invocationId":"inv-scope-1"')
    expect(line).not.toContain('/Users/alice/private/file.txt')
    expect(line).not.toContain('secret=body')
    expect(line).not.toContain('a'.repeat(64))
    expect(line).not.toContain('b'.repeat(64))
  })

  it('JSON 形态凭据字段打码（评审 B1）：序列化 params 流经摘要时不落明文', () => {
    const summary =
      'toolkit.call · action.mcp.add：添加 MCP 连接；参数 {"name":"scys","endpoint":"https://mcp.scys.com/mcp","accessToken":"ghp_secret123456","headerValue":"Bearer xyz","env":{"API_TOKEN":"tok_789"}}'
    const out = sanitizeAuditField(summary) as string
    expect(out).not.toContain('ghp_secret123456')
    expect(out).not.toContain('Bearer xyz')
    expect(out).not.toContain('tok_789')
    expect(out).toContain('https://mcp.scys.com/mcp')
    expect(out).toContain('"accessToken":"[REDACTED]"')
    expect(out).toContain('"API_TOKEN"')
  })

  it('JSON 形态打码不影响普通 JSON 数值与布尔', () => {
    const out = sanitizeAuditField('{"limit":20,"force":true,"name":"x"}') as string
    expect(out).toBe('{"limit":20,"force":true,"name":"x"}')
  })
})

describe('脚本发现审计：结构投影与片段摘要', () => {
  it.each([
    ['同引号嵌套', 'eval(f"{dict(secret="same-private-value")}")', 'same-private-value'],
    ['多层插值', 'eval(f"{dict(secret=f"{dict(token=\'nested-private-value\')}")}")', 'nested-private-value'],
    ['不同引号组合', 'eval(f\'{dict(secret="mixed-private-value")}\')', 'mixed-private-value']
  ])('真实分析器到最终 JSONL 不泄露%s中的字符串字面量', async (label, code, secret) => {
    const analysis = analyzeScriptContent(code)
    expect(analysis.coverage, label).toBe('complete')
    expect(analysis.findings.length, label).toBeGreaterThan(0)
    const dir = await tmpDir()
    const log = new SecurityAuditLog({ logDir: dir })
    log.record({
      ...baseEvent(),
      toolName: 'run_script',
      scriptAuditInput: {
        turnId: 'turn-fstring',
        contentDigest: createHash('sha256').update(code).digest('hex'),
        totalCount: analysis.totalCount,
        findings: analysis.findings
      }
    } as SecurityAuditEvent)
    await log.flush()
    const files = await fs.readdir(dir)
    const content = await fs.readFile(path.join(dir, files.find((file) => file.endsWith('.log'))!), 'utf8')
    const persisted = JSON.parse(content.trim()) as { scriptAudit?: { findings: Array<{ skeleton: string }> } }
    expect(content).not.toContain(secret)
    expect(persisted.scriptAudit?.findings[0]?.skeleton).toBe('[unavailable]')
  })

  it('真实分析器的长片段在审批侧降级，审计摘要覆盖尾部变化', () => {
    const prefix = `import subprocess\nsubprocess.run(["echo"],${' '.repeat(2100)}`
    const firstCode = `${prefix}shell=True)`
    const secondCode = `${prefix}shell=None)`
    const first = analyzeScriptContent(firstCode)
    const second = analyzeScriptContent(secondCode)
    expect(first.coverage).toBe('complete')
    expect(second.coverage).toBe('complete')
    expect(first.findings[0]?.snippet).toContain('shell=True)')
    expect(second.findings[0]?.snippet).toContain('shell=None)')
    expect(first.findings[0]?.range).toEqual(second.findings[0]?.range)

    const approval = (code: string, analysis: typeof first) => deriveClueExtras({
      toolName: 'run_script', actionClass: 'execute', baseRiskLevel: 'high',
      summary: { text: 'review script' },
      signals: [
        { kind: 'script-analysis', ...analysis },
        { kind: 'script-path-extraction', completeness: 'unknown', dynamicAccess: true,
          contentDigest: createHash('sha256').update(code).digest('hex'), parametersDigest: 'b'.repeat(64), environmentDigest: 'c'.repeat(64) }
      ]
    }).scriptEvidence
    expect(approval(firstCode, first)).toMatchObject({ sufficiency: 'undetermined', truncated: true })
    expect(approval(secondCode, second)).toMatchObject({ sufficiency: 'undetermined', truncated: true })

    const auditHash = (code: string, analysis: typeof first) => {
      const line = auditLine({
        ...baseEvent(), toolName: 'run_script',
        scriptAuditInput: {
          turnId: 'turn-long-snippet', contentDigest: createHash('sha256').update(code).digest('hex'),
          totalCount: analysis.totalCount, findings: analysis.findings
        }
      } as SecurityAuditEvent)
      return (JSON.parse(line) as { scriptAudit: { findings: Array<{ snippetSha256: string; skeleton: string }>; truncated: boolean } }).scriptAudit
    }
    const firstAudit = auditHash(firstCode, first)
    const secondAudit = auditHash(secondCode, second)
    expect(firstAudit.findings[0]?.snippetSha256).not.toBe(secondAudit.findings[0]?.snippetSha256)
    expect(firstAudit.truncated).toBe(true)
    expect(secondAudit.truncated).toBe(true)
  })

  it('从完整事件写入 JSONL：只保留投影骨架、摘要、引用与截断状态', async () => {
    const dir = await tmpDir()
    const source = [
      `requests.get("https://host-secret.example", auth=("user", "plain-password"), headers={"X-API-Key": "sk-test-secret"})  # keep-this-comment-private`,
      `payload = {"nested": ["nested-secret", 12.5]}`,
      `open("report-private.txt", "w")`,
      `value = "${'long-secret-'.repeat(210)}"`,
      `print("unterminated-secret`
    ].join('\r\n')
    const snippets = source.split('\r\n')
    const contentDigest = createHash('sha256').update(source.replace(/\r\n?/g, '\n'), 'utf8').digest('hex')
    const scriptAuditInput = {
      turnId: 'turn-script-audit',
      contentDigest,
      totalCount: 6,
      findings: [
        { pattern: 'A6', class: 'network-api', range: { startLine: 1, startCol: 1, endLine: 1, endCol: snippets[0]!.length + 1 }, snippet: snippets[0]! },
        { pattern: 'B1', class: 'reflection', range: { startLine: 2, startCol: 1, endLine: 2, endCol: snippets[1]!.length + 1 }, snippet: snippets[1]! },
        { pattern: 'A7', class: 'file-write', range: { startLine: 3, startCol: 1, endLine: 3, endCol: snippets[2]!.length + 1 }, snippet: snippets[2]! },
        { pattern: 'A7', class: 'file-write', range: { startLine: 4, startCol: 1, endLine: 4, endCol: snippets[3]!.length + 1 }, snippet: snippets[3]! },
        { pattern: 'A1', class: 'process-creation', range: { startLine: 5, startCol: 1, endLine: 5, endCol: snippets[4]!.length + 1 }, snippet: snippets[4]! }
      ]
    }
    const log = new SecurityAuditLog({ logDir: dir })
    log.record({ ...baseEvent(), toolName: 'run_script', scriptAuditInput } as SecurityAuditEvent)
    await log.flush()

    const files = await fs.readdir(dir)
    const content = await fs.readFile(path.join(dir, files.find((file) => file.endsWith('.log'))!), 'utf8')
    const persisted = JSON.parse(content.trim()) as { scriptAudit?: {
      sessionId: string; turnId: string; contentDigest: string; totalCount: number; truncated: boolean
      findings: Array<{ pattern: string; range: unknown; skeleton: string; snippetSha256: string }>
    } }
    expect(persisted.scriptAudit).toMatchObject({
      sessionId: 's1', turnId: 'turn-script-audit', contentDigest, totalCount: 6, truncated: true
    })
    expect(persisted.scriptAudit?.findings).toHaveLength(5)
    expect(persisted.scriptAudit?.findings[0]).toMatchObject({ pattern: 'A6', range: scriptAuditInput.findings[0]!.range })
    expect(persisted.scriptAudit?.findings[0]?.skeleton).toContain('requests.get')
    expect(persisted.scriptAudit?.findings[0]?.skeleton).toContain('auth=')
    expect(persisted.scriptAudit?.findings[0]?.skeleton).toContain('"…"')
    expect(persisted.scriptAudit?.findings[0]?.snippetSha256).toBe(
      createHash('sha256').update(snippets[0]!, 'utf8').digest('hex')
    )
    expect(persisted.scriptAudit?.findings[3]?.skeleton.length).toBeLessThanOrEqual(2_000)
    expect(persisted.scriptAudit?.findings[3]?.snippetSha256).toBe(
      createHash('sha256').update(snippets[3]!, 'utf8').digest('hex')
    )
    expect(persisted.scriptAudit?.findings[4]?.skeleton).toBe('[unavailable]')
    for (const secret of ['host-secret.example', 'plain-password', 'sk-test-secret', 'keep-this-comment-private', 'nested-secret', 'report-private.txt', 'long-secret', 'unterminated-secret']) {
      expect(content).not.toContain(secret)
    }
    expect(content).not.toContain(source)
  })

  it('同定位键内容变更会改变摘要；同一原始片段可稳定复算', () => {
    const makeLine = (snippet: string) => auditLine({ ...baseEvent(), scriptAuditInput: {
      turnId: 'turn-hash', contentDigest: 'a'.repeat(64), totalCount: 1,
      findings: [{ pattern: 'A6', class: 'network-api', range: { startLine: 1, startCol: 1, endLine: 1, endCol: 20 }, snippet }]
    } } as SecurityAuditEvent)
    const first = JSON.parse(makeLine("requests.get('https://one.test')")) as { scriptAudit?: { findings: Array<{ snippetSha256: string }> } }
    const second = JSON.parse(makeLine("requests.get('https://two.test')")) as { scriptAudit?: { findings: Array<{ snippetSha256: string }> } }
    const replay = JSON.parse(makeLine("requests.get('https://one.test')")) as { scriptAudit?: { findings: Array<{ snippetSha256: string }> } }
    expect(first.scriptAudit?.findings[0]?.snippetSha256).not.toBe(second.scriptAudit?.findings[0]?.snippetSha256)
    expect(first.scriptAudit?.findings[0]?.snippetSha256).toBe(replay.scriptAudit?.findings[0]?.snippetSha256)
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
    log.record({ ...baseEvent(), factsSnapshotId: 'fact-0123456789abcdef01234567', extractorVersion: 'host-tool-facts-v1', factsRevision: 2 })
    await log.flush()
    await expect(querySecurityAuditLog(dir, { lane: 'desktop', event: 'policy.decision' })).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ factsSnapshotId: 'fact-0123456789abcdef01234567', extractorVersion: 'host-tool-facts-v1', factsRevision: 2 })]))
  })

  it('round-trips policy provenance, review path, and deferred causal references through persistent query', async () => {
    const dir = await tmpDir()
    const log = new SecurityAuditLog({ logDir: dir })
    log.record({ ...baseEvent(), lane: 'wechat', policyDomain: 'im', policyBehaviorVersion: 'im-standard-v2', policyRevision: 17,
      factsCompleteness: 'complete', reviewPath: 'approval-agent', fallbackCause: 'agent-timeout', todoId: 'todo-17',
      invocationId: 'invocation-17', executionState: 'dispatching', dispatchKey: 'dispatch-17' })
    await log.flush()
    await expect(querySecurityAuditLog(dir, { lane: 'wechat', event: 'policy.decision' })).resolves.toMatchObject([{
      policyDomain: 'im', policyBehaviorVersion: 'im-standard-v2', policyRevision: 17,
      factsCompleteness: 'complete', reviewPath: 'approval-agent', fallbackCause: 'agent-timeout',
      todoId: 'todo-17', invocationId: 'invocation-17', executionState: 'dispatching', dispatchKey: 'dispatch-17'
    }])
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

describe('安全审计日志：保留天数可调（§5.6-1）', () => {
  it('setRetentionDays 立即生效；非法值忽略', async () => {
    const dir = await tmpDir()
    const log = new SecurityAuditLog({ logDir: dir })
    expect(log.getRetentionDays()).toBe(180)
    log.setRetentionDays(30)
    expect(log.getRetentionDays()).toBe(30)
    log.setRetentionDays(0)
    log.setRetentionDays(Number.NaN)
    expect(log.getRetentionDays()).toBe(30)
  })

  it('before/after 字段写入前经脱敏（含新旧值不落 secret）', () => {
    const line = auditLine({ ...baseEvent(), before: 'ask', after: 'allow sk-abcdef123' })
    expect(line).toContain('"before":"ask"')
    expect(line).not.toContain('sk-abcdef123')
  })
})
