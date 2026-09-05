import { describe, expect, it } from 'vitest'
import { analyzeShellFacts } from './shellAnalyzer'

describe('analyzeShellFacts', () => {
  it('按 dialect 提取操作、连接符、路径和 cwd 变化，不返回裁决字段', () => {
    const facts = analyzeShellFacts('cd ./src && cat "./index.ts" | head -n 2', 'posix-bash')
    expect(facts).toMatchObject({
      dialect: 'posix-bash',
      connectors: ['&&', '|'],
      cwdChanges: ['./src'],
      analysisCompleteness: 'complete'
    })
    expect(facts.operations.map((operation) => operation.verb)).toEqual(['cd', 'cat', 'head'])
    expect(facts.paths).toContain('./index.ts')
    expect(facts).not.toHaveProperty('verdict')
    expect(facts).not.toHaveProperty('denyType')
  })

  it('无法完整解析控制流时保留事实并标记 partial', () => {
    const facts = analyzeShellFacts('echo $(whoami) > ./out.txt', 'posix-bash')
    expect(facts.operations[0]?.verb).toBe('echo')
    expect(facts.analysisCompleteness).toBe('partial')
    expect(facts.unresolved).toContain('segment:0:shell-control-flow')
  })

  it('不把引号和注释中的符号误判为真实连接符', () => {
    const facts = analyzeShellFacts('echo "a|b;c" # && ignored\nprintf "$env:NAME"', 'windows-powershell')
    expect(facts.connectors).toEqual([';'])
    expect(facts.operations.map((operation) => operation.verb)).toEqual(['echo', 'printf'])
  })

  it('保留转义字符并忽略转义后的连接符', () => {
    const facts = analyzeShellFacts(String.raw`printf "a\|b" \; echo ok`, 'posix-bash')
    expect(facts.connectors).toEqual([])
    expect(facts.operations.map((operation) => operation.verb)).toEqual(['printf', 'echo'])
    expect(facts.analysisCompleteness).toBe('complete')
  })

  it('变量和参数展开事实不误报连接符，但变量语法保持可审计', () => {
    const facts = analyzeShellFacts('printf "${NAME:-default}" && echo "$OTHER"', 'posix-bash')
    expect(facts.connectors).toEqual(['&&'])
    expect(facts.operations.map((operation) => operation.verb)).toEqual(['printf', 'echo'])
    expect(facts.analysisCompleteness).toBe('partial')
    expect(facts.unresolved).toContain('segment:0:shell-control-flow')
  })
})
