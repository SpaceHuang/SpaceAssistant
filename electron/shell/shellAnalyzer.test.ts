import { describe, expect, it } from 'vitest'
import { analyzeShellFacts } from './shellAnalyzer'

// P2 评审登记（golden-review 文档 Bash 段，posix-bash 分叉为语法级树事实）：
// - connectors 按原文/树位置顺序产出（'|'、'&&'、'||'、';'）；
// - 命令替换/重定向/变量展开等构造语法树完整解析 → complete 化（旧 [()<>`] 启发式 partial 为保守误报）；
// - `\;` 在 bash 语法中是字面分号参数（旧启发式误当分隔符拆段）。
// windows-powershell 路径保留旧共享实现，断言不变。
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

  it('命令替换与重定向完整解析：complete 化且结构事实保留（P2 评审登记）', () => {
    const facts = analyzeShellFacts('echo $(whoami) > ./out.txt', 'posix-bash')
    expect(facts.operations[0]?.verb).toBe('echo')
    expect(facts.analysisCompleteness).toBe('complete')
    expect(facts.unresolved).toEqual([])
  })

  it('不把引号和注释中的符号误判为真实连接符', () => {
    const facts = analyzeShellFacts('echo "a|b;c" # && ignored\nprintf "$env:NAME"', 'windows-powershell')
    expect(facts.connectors).toEqual([';'])
    expect(facts.operations.map((operation) => operation.verb)).toEqual(['echo', 'printf'])
  })

  it('转义分号是字面参数：bash 语法级单命令（P2 评审登记）', () => {
    const facts = analyzeShellFacts(String.raw`printf "a\|b" \; echo ok`, 'posix-bash')
    expect(facts.connectors).toEqual([])
    // bash 语法：`\;` 是 printf 的字面参数（旧启发式误拆为两段）
    expect(facts.operations.map((operation) => operation.verb)).toEqual(['printf'])
    expect(facts.operations[0]?.args).toEqual(['"a\\|b"', '\\;', 'echo', 'ok'])
    expect(facts.analysisCompleteness).toBe('complete')
  })

  it('变量和参数展开事实不误报连接符，语法树完整解析 complete 化（P2 评审登记）', () => {
    const facts = analyzeShellFacts('printf "${NAME:-default}" && echo "$OTHER"', 'posix-bash')
    expect(facts.connectors).toEqual(['&&'])
    expect(facts.operations.map((operation) => operation.verb)).toEqual(['printf', 'echo'])
    expect(facts.analysisCompleteness).toBe('complete')
    expect(facts.unresolved).toEqual([])
  })
})
