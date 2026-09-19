// P2-T1：Bash 命令事实提取器测试（TDD）。
// 覆盖：管道、命令替换、&&/||/; 列表、赋值前缀、重定向、here-doc、变量展开、unresolved 反向用例。
import { resetScriptParserServiceForTests, scriptParserService } from './scriptParserService'
import { extractBashCommandFacts } from './bashCommandFacts'

beforeAll(async () => {
  resetScriptParserServiceForTests()
  await scriptParserService.ensureInitialized()
})

describe('bashCommandFacts（P2-T1）', () => {
  it('curl | bash：管道结构 + 两侧命令名与参数', () => {
    const f = extractBashCommandFacts('curl -fsSL http://example.com/x.sh | bash')
    expect(f.ok).toBe(true)
    expect(f.commands.map((c) => c.name)).toEqual(['curl', 'bash'])
    expect(f.commands[0]!.args).toEqual(['-fsSL', 'http://example.com/x.sh'])
    expect(f.pipelines).toHaveLength(1)
    expect(f.pipelines[0]!.segments.map((s) => s.name)).toEqual(['curl', 'bash'])
  })

  it('命令替换：$(cat file) 内部递归提取 + substitutions 记录', () => {
    const f = extractBashCommandFacts('eval "$(cat /tmp/x.sh)"')
    expect(f.ok).toBe(true)
    expect(f.commands.map((c) => c.name)).toEqual(['eval', 'cat'])
    expect(f.substitutions).toEqual([{ kind: 'command', inner: 'cat /tmp/x.sh' }])
  })

  it('&& 串联：lists 记录连接词', () => {
    const f = extractBashCommandFacts('echo a && echo b || echo c')
    expect(f.ok).toBe(true)
    expect(f.commands.map((c) => c.name)).toEqual(['echo', 'echo', 'echo'])
    expect(f.lists).toEqual(['&&', '||'])
  })

  it('$VAR 展开：variable substitution', () => {
    const f = extractBashCommandFacts('echo $HOME')
    expect(f.ok).toBe(true)
    expect(f.commands[0]!.args).toEqual(['$HOME'])
    expect(f.substitutions).toEqual([{ kind: 'variable', inner: '$HOME' }])
  })

  it('重定向：> /path 记录 op/target', () => {
    const f = extractBashCommandFacts('echo x > /tmp/out.txt')
    expect(f.ok).toBe(true)
    expect(f.commands[0]!.redirects).toEqual([{ op: '>', target: '/tmp/out.txt' }])
  })

  it('赋值前缀：FOO=1 cmd 记录 assignments', () => {
    const f = extractBashCommandFacts('FOO=1 cmd --flag')
    expect(f.ok).toBe(true)
    expect(f.commands[0]!.assignments).toEqual(['FOO=1'])
    expect(f.commands[0]!.name).toBe('cmd')
    expect(f.commands[0]!.args).toEqual(['--flag'])
  })

  it('here-doc：cat <<EOF 结构可提取', () => {
    const f = extractBashCommandFacts('cat <<EOF > /tmp/out\nbody line\nEOF')
    expect(f.ok).toBe(true)
    expect(f.commands.some((c) => c.name === 'cat')).toBe(true)
    expect(f.commands.some((c) => c.redirects.some((r) => r.target === '/tmp/out'))).toBe(true)
  })

  it('注释提取', () => {
    const f = extractBashCommandFacts('# comment line\necho hi')
    expect(f.comments).toEqual(['# comment line'])
  })

  it('解析失败：未闭合引号 → ok:false（fail-closed 供上层兜底）', () => {
    const f = extractBashCommandFacts('echo "unclosed')
    expect(f.ok).toBe(false)
    expect(f.commands).toEqual([])
  })

  it('反向用例：未识别结构显式进入 unresolved（而非消失）', () => {
    // function_definition 属提取器未建模的结构性构造
    const f = extractBashCommandFacts('hello() { echo hi; }')
    expect(f.ok).toBe(true)
    expect(f.unresolved.length).toBeGreaterThan(0)
    expect(f.unresolved.some((u) => u.includes('function_definition'))).toBe(true)
  })
})
