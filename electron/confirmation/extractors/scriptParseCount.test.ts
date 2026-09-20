// P1-T3 DoD：解析次数 spy 断言 + 未知构造/包裹式反向用例（§3 不变量 1(c) 落点验证）。
import { describe, expect, it, vi, afterEach } from 'vitest'
import { scriptParserService } from '../../shell/scriptParserService'
import { parsePythonModule, analyzeScriptContent } from '../../shell/scriptContentSecurity'
import { extractScriptSignals } from './scriptAnalysisExtractor'
import { runExtractors } from './runExtractors'
import type { IrModule } from '../../shell/scriptIr/types'
import type { EnvFacts, ToolActionDescriptor } from '../../../src/shared/confirmation/types'

const ENV: EnvFacts = {
  workDir: 'C:/tmp/work',
  os: 'win32'
} as unknown as EnvFacts

const DESCRIPTOR: ToolActionDescriptor = {
  toolName: 'run_script',
  actionClass: 'execute',
  riskLevel: 'high',
  extractors: ['script-analysis']
} as unknown as ToolActionDescriptor

const OK_CODE = 'import os\nos.system("ls")\n'

function spyParse(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(scriptParserService, 'parse')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('P1-T3 解析次数 spy 断言（发现 B：热路径重复解析消除）', () => {
  it('extractScriptSignals 不传预解析：恰好 1 次 parse', () => {
    const spy = spyParse()
    extractScriptSignals(OK_CODE, ENV)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('extractScriptSignals 传预解析 IR：0 次 parse（共享成功）', () => {
    const spy = spyParse()
    const ir: IrModule = parsePythonModule(OK_CODE)
    const before = spy.mock.calls.length
    extractScriptSignals(OK_CODE, ENV, ir)
    expect(spy.mock.calls.length).toBe(before)
  })

  it('toolCallGate 门控路径等价模拟（parse 1 次 → IR 同时传 :352 与 :360）：恰好 1 次 parse', () => {
    const spy = spyParse()
    // 门控代码：parsePythonModule 一次，IR 传给 extractScriptSignals 与 analyzeScriptContent
    const ir = parsePythonModule(OK_CODE)
    const before = spy.mock.calls.length
    extractScriptSignals(OK_CODE, ENV, ir)
    analyzeScriptContent(OK_CODE, { remote: false }, ir)
    expect(spy.mock.calls.length).toBe(before)
  })

  it('runExtractors descriptor 路径（不传预解析）：正常工作且恰好 1 次 parse', () => {
    const spy = spyParse()
    const facts = runExtractors(DESCRIPTOR, { code: OK_CODE }, ENV)
    expect(spy).toHaveBeenCalledTimes(1)
    const kinds = facts.signals.map((s) => s.kind)
    expect(kinds).toContain('script-analysis')
  })
})

describe('P1-T2/T3 未知构造与包裹式反向用例（IrCoverageError → extraction-failed → 人工）', () => {
  // match 语句是分类表 ④ 显式未建模构造（合法 Python，适配器抛 IrCoverageError）
  const UNCOVERED = 'def f(x):\n    match x:\n        case 1:\n            return 1\n'

  it('parsePythonModule 抛 IrCoverageError（适配器未覆盖构造）', () => {
    expect(() => parsePythonModule(UNCOVERED)).toThrow(/IR adapter uncovered/)
  })

  it('analyzeScriptContent 对未覆盖构造返回 A-fail → ask（不抛出到调用方）', () => {
    const r = analyzeScriptContent(UNCOVERED, {})
    expect(r.verdict).toBe('ask')
    expect(r.patterns).toContain('A-fail')
  })

  it('extractScriptSignals 产出 extraction-failed 而非 script-analysis: clean', () => {
    const { signals } = extractScriptSignals(UNCOVERED, ENV)
    expect(signals.some((s) => s.kind === 'extraction-failed')).toBe(true)
    const scriptAnalysis = signals.find((s) => s.kind === 'script-analysis')
    expect(scriptAnalysis?.signal).not.toBe('clean')
  })

  it('包裹式反向：未建模构造内藏 os.system 不得 allow / clean（评审 v4 B1‴-d）', () => {
    const wrapped = 'def run(cmd):\n    match cmd:\n        case _:\n            pass\n    return cmd\n\nimport os\nrun(os.environ)\n'
    // 该样本含 os.environ（未命中危险 attr 表）但整体未建模 → 必须 A-fail ask，绝不 allow
    const r = analyzeScriptContent(wrapped, {})
    expect(r.verdict).not.toBe('allow')
    const { signals } = extractScriptSignals(wrapped, ENV)
    const scriptAnalysis = signals.find((s) => s.kind === 'script-analysis')
    expect(scriptAnalysis?.signal).not.toBe('clean')
    expect(signals.some((s) => s.kind === 'extraction-failed')).toBe(true)
  })

  it('P0-3/P1-1 回归：for...else / while...else 的 else 体不得 allow（desktop + remote）', () => {
    const forElse = 'for i in [1]:\n    pass\nelse:\n    eval("1")'
    const r = analyzeScriptContent(forElse, {})
    expect(r.verdict).not.toBe('allow')
    const whileElse = 'while x:\n    pass\nelse:\n    import os\n    os.system("id")'
    const r2 = analyzeScriptContent(whileElse, {})
    expect(r2.verdict).not.toBe('allow')
    // remote：certify 必须 fail（else 体藏 eval/危险调用不得通过认证）
    const rRemote = analyzeScriptContent(forElse, { remote: true })
    expect(rRemote.verdict).not.toBe('allow')
  })

  it('P0-3 Certifier 回归锁：Analyzer 无命中、else 体藏 certifier 未建模构造（with）时 remote 不得 allow', () => {
    // 该样本 Analyzer 零命中（with open 无危险 attr）→ verdict=allow 的前提是 certifier 通过；
    // certifier 若回退 orelse 遍历，with（未建模）会被跳过 → certify=true → remote allow。
    // 断言 remote verdict !== 'allow' 即锁死 certifier 的 orelse 遍历路径。
    const code = 'for i in [1]:\n    pass\nelse:\n    with open("f") as fh:\n        pass'
    const r = analyzeScriptContent(code, { remote: true })
    expect(r.verdict).not.toBe('allow')
  })

  it('包裹式反向（危险调用真藏在未建模体内）：不得 allow', () => {
    const wrapped = 'import os\n\ndef dispatch(x):\n    match x:\n        case "go":\n            os.system("ls")\n'
    const r = analyzeScriptContent(wrapped, {})
    expect(r.verdict).not.toBe('allow')
  })
})
