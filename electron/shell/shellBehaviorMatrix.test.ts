import { describe, expect, it } from 'vitest'
import { analyzeShellFacts } from './shellAnalyzer'

type MatrixCase = {
  name: string
  bash: string
  powershell: string
  expectedCompleteness: 'complete' | 'partial'
  /** PS 路径（P2 期间保留旧共享实现）与本条 bash 期望不同时单独声明 */
  expectedCompletenessPs?: 'complete' | 'partial'
  expectedConnectors: string[]
}

// P3 评审登记（golden-review PS 段）：windows-powershell 分叉接入语法级树事实后，redirection / command substitution
// 在 PS 侧同样 complete 化（P3-T6：PS 36 条 drift 全部登记「接受」，verdict 零弱化、eligible 零翻转）。
// P2 评审登记（golden-review 文档 Bash 段）：redirection / command substitution 由 partial → complete——
// 旧 [<>$(`)] 启发式判 partial 属保守误报；语法树完整解析下 complete 化，路径安全面由树事实增强覆盖（只增不减）。
const MATRIX: MatrixCase[] = [
  { name: 'quoted separators', bash: 'printf "a|b;c"', powershell: 'Write-Output "a|b;c"', expectedCompleteness: 'complete', expectedConnectors: [] },
  { name: 'pipeline and conditional', bash: 'cat ./a.txt | head -n 2 && echo ok', powershell: 'Get-Content .\\a.txt | Select-Object -First 2; Write-Output ok', expectedCompleteness: 'complete', expectedConnectors: ['|', '&&'] },
  { name: 'variables', bash: 'printf "$NAME"', powershell: 'Write-Output "$env:NAME"', expectedCompleteness: 'complete', expectedConnectors: [] },
  { name: 'redirection', bash: 'echo ok > ./out.txt', powershell: 'Write-Output ok > .\out.txt', expectedCompleteness: 'complete', expectedConnectors: [] },
  { name: 'multiline and comments', bash: 'echo one\necho two # ignored', powershell: 'Write-Output one\nWrite-Output two # ignored', expectedCompleteness: 'complete', expectedConnectors: [';'] },
  { name: 'command substitution', bash: 'echo $(date)', powershell: 'Write-Output $(Get-Date)', expectedCompleteness: 'complete', expectedConnectors: [] },
  { name: 'grouping', bash: '(echo one; echo two)', powershell: '(Write-Output one; Write-Output two)', expectedCompleteness: 'partial', expectedConnectors: [';'] },
  { name: 'cwd change', bash: 'cd ./src && pwd', powershell: 'Set-Location .\\src; Get-Location', expectedCompleteness: 'complete', expectedConnectors: ['&&'] },
  { name: 'unclosed quote', bash: 'echo "unterminated', powershell: 'Write-Output "unterminated', expectedCompleteness: 'partial', expectedConnectors: [] }
]

describe('Shell behavior matrix', () => {
  it.each(MATRIX)('$name: Bash facts', ({ bash, expectedCompleteness, expectedConnectors }) => {
    const facts = analyzeShellFacts(bash, 'posix-bash')
    expect(facts.analysisCompleteness).toBe(expectedCompleteness)
    expect(facts.connectors).toEqual(expectedConnectors)
  })

  it.each(MATRIX)('$name: PowerShell facts', ({ powershell, expectedCompleteness, expectedCompletenessPs }) => {
    const facts = analyzeShellFacts(powershell, 'windows-powershell')
    expect(facts.analysisCompleteness).toBe(expectedCompletenessPs ?? expectedCompleteness)
  })
})
