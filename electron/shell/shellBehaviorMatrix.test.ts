import { describe, expect, it } from 'vitest'
import { analyzeShellFacts } from './shellAnalyzer'

type MatrixCase = {
  name: string
  bash: string
  powershell: string
  expectedCompleteness: 'complete' | 'partial'
  expectedConnectors: string[]
}

const MATRIX: MatrixCase[] = [
  { name: 'quoted separators', bash: 'printf "a|b;c"', powershell: 'Write-Output "a|b;c"', expectedCompleteness: 'complete', expectedConnectors: [] },
  { name: 'pipeline and conditional', bash: 'cat ./a.txt | head -n 2 && echo ok', powershell: 'Get-Content .\\a.txt | Select-Object -First 2; Write-Output ok', expectedCompleteness: 'complete', expectedConnectors: ['|', '&&'] },
  { name: 'variables', bash: 'printf "$NAME"', powershell: 'Write-Output "$env:NAME"', expectedCompleteness: 'complete', expectedConnectors: [] },
  { name: 'redirection', bash: 'echo ok > ./out.txt', powershell: 'Write-Output ok > .\\out.txt', expectedCompleteness: 'partial', expectedConnectors: [] },
  { name: 'multiline and comments', bash: 'echo one\necho two # ignored', powershell: 'Write-Output one\nWrite-Output two # ignored', expectedCompleteness: 'complete', expectedConnectors: [';'] },
  { name: 'command substitution', bash: 'echo $(date)', powershell: 'Write-Output $(Get-Date)', expectedCompleteness: 'partial', expectedConnectors: [] },
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

  it.each(MATRIX)('$name: PowerShell facts', ({ powershell, expectedCompleteness }) => {
    const facts = analyzeShellFacts(powershell, 'windows-powershell')
    expect(facts.analysisCompleteness).toBe(expectedCompleteness)
  })
})
