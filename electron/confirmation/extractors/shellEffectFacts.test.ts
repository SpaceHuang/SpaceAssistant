import { describe, expect, it } from 'vitest'
import { classifyShellCommandEffect } from './shellEffectFacts'
import type { ShellAnalysisResult } from '../../shell/shellTypes'
import { analyzeShellCommand } from '../../shell/analyzeShellCommand'

function analysis(operations: Array<{ verb: string; args: string[] }>, completeness: 'complete' | 'partial' = 'complete', redirects: string[] = [], connectors: string[] = [], unresolved: string[] = []): ShellAnalysisResult {
  return {
    verdict: 'allow', segments: [], pathVerdict: { decision: 'allow', violations: [], warnings: [], outsideWorkDirRisk: false, requiresRiskAck: false },
    shellSecurityHints: { requiresRiskAck: false, outsideWorkDirRisk: false, warnings: [] },
    facts: { dialect: 'posix-bash', operations: operations.map((op, segmentIndex) => ({ ...op, segmentIndex })), connectors, paths: [], redirects, cwdChanges: [], analysisCompleteness: completeness, unresolved }
  }
}

describe('classifyShellCommandEffect', () => {
  it('只对完整、白名单内、无重定向命令标记 read-only', () => {
    expect(classifyShellCommandEffect('cat README.md', analysis([{ verb: 'cat', args: ['README.md'] }]))).toBe('read-only')
    expect(classifyShellCommandEffect('cat a > b', analysis([{ verb: 'cat', args: ['a'] }], 'complete', ['b']))).toBe('unknown')
    expect(classifyShellCommandEffect('cat a', analysis([{ verb: 'cat', args: ['a'] }], 'partial'))).toBe('unknown')
  })

  it('写命令归为 mutating，读工具的危险选项 fail closed', () => {
    expect(classifyShellCommandEffect('rm file', analysis([{ verb: 'rm', args: ['file'] }]))).toBe('mutating')
    expect(classifyShellCommandEffect('find . -delete', analysis([{ verb: 'find', args: ['.', '-delete'] }]))).toBe('unknown')
    expect(classifyShellCommandEffect('sort -o out in', analysis([{ verb: 'sort', args: ['-o', 'out', 'in'] }]))).toBe('unknown')
    expect(classifyShellCommandEffect('git diff --output=out', analysis([{ verb: 'git', args: ['diff', '--output=out'] }]))).toBe('unknown')
    expect(classifyShellCommandEffect('find . -fprint out', analysis([{ verb: 'find', args: ['.', '-fprint', 'out'] }]))).toBe('unknown')
    expect(classifyShellCommandEffect('find . -fprintf out', analysis([{ verb: 'find', args: ['.', '-fprintf', 'out'] }]))).toBe('unknown')
  })

  it('存在未解析语法或不支持的连接符时不产生 read-only', () => {
    expect(classifyShellCommandEffect('cat file', analysis([{ verb: 'cat', args: ['file'] }], 'complete', [], [], ['unknown-shell-effect']))).toBe('unknown')
    expect(classifyShellCommandEffect('cat a & cat b', analysis([{ verb: 'cat', args: ['a'] }, { verb: 'cat', args: ['b'] }], 'complete', [], ['&']))).toBe('unknown')
  })
})

it('analyzeShellCommand 将 AST 重定向目标独立于普通路径事实输出', async () => {
  const result = await analyzeShellCommand('/tmp', 'cat /tmp/in.txt > /tmp/out.txt', 'linux')
  expect(result.facts?.redirects).toEqual(['/tmp/out.txt'])
  expect(result.facts?.paths).not.toContain('/tmp/out.txt')
  expect(classifyShellCommandEffect('cat /tmp/in.txt > /tmp/out.txt', result)).toBe('unknown')
})

it('命令替换中的写命令不能被外层只读 verb 掩盖', async () => {
  const result = await analyzeShellCommand('/tmp', 'echo $(touch /tmp/x)', 'linux')
  expect(classifyShellCommandEffect('echo $(touch /tmp/x)', result)).not.toBe('read-only')
})
