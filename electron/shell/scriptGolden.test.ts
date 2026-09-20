// P1-T0 / P1-T5：Python Golden 判定基线录制与比对。
//
// 录制模式（GOLDEN_RECORD=1）：对每条样本跑 analyzeScriptContent + extractScriptSignals，
// 把旧实现的 { verdict, patterns, signals, legacyParsed } 写入样本同名 .json 作为基线。
// 仅允许在「替换旧实现之前」的基线 commit 上运行录制（禁止用切换后实现重新录制充数）。
//
// 比对模式（默认，P1-T5）：每条样本与基线 .json 逐字段 diff；任何不一致即红。
// 经 Golden 评审登记为「接受」的变化，显式列入 ACCEPTED_DRIFT 白名单（id → 处置结论索引）。
import fs from 'node:fs'
import path from 'node:path'
import { analyzeScriptContent, parsePythonModule } from './scriptContentSecurity'
import { extractScriptSignals } from '../confirmation/extractors/scriptAnalysisExtractor'

const GOLDEN_DIR = path.resolve(__dirname, 'testdata', 'golden', 'python')
const RECORD_MODE = process.env.GOLDEN_RECORD === '1'

type GoldenBaseline = {
  id: string
  group: 'legacy-parseable' | 'previously-failed'
  legacyParsed: boolean
  verdict: 'allow' | 'ask' | 'deny'
  patterns: string[]
  reason?: string
  signals: Array<Record<string, unknown>>
}

function loadSamples(): Array<{ id: string; group: GoldenBaseline['group']; pyPath: string; code: string }> {
  const manifest = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, 'manifest.json'), 'utf8')) as {
    samples: Array<{ id: string; group: GoldenBaseline['group'] }>
  }
  return manifest.samples.map(({ id, group }) => {
    const pyPath = path.join(GOLDEN_DIR, `${id}.py`)
    return { id, group, pyPath, code: fs.readFileSync(pyPath, 'utf8') }
  })
}

function snapshotOf(id: string, group: GoldenBaseline['group'], code: string): GoldenBaseline {
  let legacyParsed = true
  try {
    parsePythonModule(code)
  } catch {
    legacyParsed = false
  }
  const analysis = analyzeScriptContent(code, {})
  const { signals } = extractScriptSignals(code, {})
  return {
    id,
    group,
    legacyParsed,
    verdict: analysis.verdict,
    patterns: analysis.patterns,
    ...(analysis.reason ? { reason: analysis.reason } : {}),
    signals: JSON.parse(JSON.stringify(signals)) as Array<Record<string, unknown>>
  }
}

// P1-T5 登记表：Golden 评审通过后，把「接受」的漂移 id → 结论填入此处。
// 约束：deny/ask → allow 的降级、eligible=false → true 的升级绝不允许进白名单（P2-T5 同规则）。
// 逐条处置结论与证据见 docs/develop/script-security-parser-upgrade-golden-review.md Python 段。
const ACCEPTED_DRIFT: Record<string, string> = {
    'b04-fstring-path': '接受：certify 对 IR 扩展构造严格化，仅新增 script-uncertified（remote allow→ask 方向安全；desktop 判定零变化；A 组 A-fail=0）',
    'b19-subscript-read': '接受：certify 对 IR 扩展构造严格化，仅新增 script-uncertified（remote allow→ask 方向安全；desktop 判定零变化；A 组 A-fail=0）',
    'b22-conditional-expr': '接受：certify 对 IR 扩展构造严格化，仅新增 script-uncertified（remote allow→ask 方向安全；desktop 判定零变化；A 组 A-fail=0）',
    'b23-list-comprehension': '接受：certify 对 IR 扩展构造严格化，仅新增 script-uncertified（remote allow→ask 方向安全；desktop 判定零变化；A 组 A-fail=0）',
    'b27-del-statement': '接受：certify 对 IR 扩展构造严格化，仅新增 script-uncertified（remote allow→ask 方向安全；desktop 判定零变化；A 组 A-fail=0）',
    'b29-assert-statement': '接受：certify 对 IR 扩展构造严格化，仅新增 script-uncertified（remote allow→ask 方向安全；desktop 判定零变化；A 组 A-fail=0）',
    'b30-raise-statement': '接受：certify 对 IR 扩展构造严格化，仅新增 script-uncertified（remote allow→ask 方向安全；desktop 判定零变化；A 组 A-fail=0）',
    'b33-chained-compare': '接受：certify 对 IR 扩展构造严格化，仅新增 script-uncertified（remote allow→ask 方向安全；desktop 判定零变化；A 组 A-fail=0）',
    'b01-dict-literal': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b02-dict-empty': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b03-fstring-basic': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b05-with-open-read': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b06-with-open-write': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b07-try-except': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b08-try-finally': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b09-def-basic': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b10-def-default-args': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b11-class-basic': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b12-class-inheritance': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b13-decorator-staticmethod': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b14-decorator-functools': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b15-async-def': '接受：A-fail 兜底 → 真实模式命中（verdict 保持 ask，不降级）',
    'b16-async-with': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b17-lambda-basic': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b18-lambda-key': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b20-subscript-write': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b21-slice': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b24-dict-comprehension': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b25-while-augassign': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b26-return-value': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b28-global-statement': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b31-set-literal': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b32-star-args': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'a07-for-if-nested': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'a08-if-else': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'a42-danger-in-for-if': '接受：A-fail 兜底 → 真实模式命中（verdict 保持 ask，不降级）',
    'a45-compare-and-unary': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b35-def-wraps-os-system': '接受：A-fail 兜底 → 真实模式命中（verdict 保持 ask，不降级）',
    'b36-with-wraps-open-absolute-write': '接受：A-fail ask → 真实命中 deny（变严方向）',
    'b37-try-wraps-os-system': '接受：A-fail 兜底 → 真实模式命中（verdict 保持 ask，不降级）',
    'b38-class-wraps-subprocess': '接受：A-fail 兜底 → 真实模式命中（verdict 保持 ask，不降级）',
    'b39-async-wraps-requests': '接受：A-fail 兜底 → 真实模式命中（verdict 保持 ask，不降级）',
    'b40-lambda-wraps-eval': '接受：A-fail 兜底 → 真实模式命中（verdict 保持 ask，不降级）',
    'b41-fstring-wraps-network-arg': '接受：A-fail 兜底 → 真实模式命中（verdict 保持 ask，不降级）',
    'b42-dict-wraps-eval-value': '接受：A-fail 兜底 → 真实模式命中（verdict 保持 ask，不降级）',
    'b43-socket-in-def': '接受：A-fail 兜底 → 真实模式命中（verdict 保持 ask，不降级）',
    'b44-with-wraps-relative-write': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
    'b45-while-loop': '接受：原必失败集改善——旧 A-fail 因语法不支持，实为纯安全构造无危险面（逐条证据见评审文档）',
}

describe('scriptGolden（Python 判定基线，P1-T0/P1-T5）', () => {
  const samples = loadSamples()

  it('样本集规模 ≥ 80 且 id 唯一', () => {
    expect(samples.length).toBeGreaterThanOrEqual(80)
    expect(new Set(samples.map((s) => s.id)).size).toBe(samples.length)
    expect(samples.filter((s) => s.group === 'legacy-parseable').length).toBeGreaterThanOrEqual(40)
    expect(samples.filter((s) => s.group === 'previously-failed').length).toBeGreaterThanOrEqual(30)
  })

  if (RECORD_MODE) {
    it('录制模式：导出全部样本基线 .json（仅限基线 commit 运行）', () => {
      for (const { id, group, code } of samples) {
        const snapshot = snapshotOf(id, group, code)
        const outPath = path.join(GOLDEN_DIR, `${id}.json`)
        fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
      }
      console.log(`[scriptGolden] recorded ${samples.length} baselines into ${GOLDEN_DIR}`)
    })
  } else {
    it.each(samples)('$id：判定与基线一致', (sample) => {
      const baselinePath = path.join(GOLDEN_DIR, `${sample.id}.json`)
      expect(fs.existsSync(baselinePath)).toBe(true)
      const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as GoldenBaseline
      const current = snapshotOf(sample.id, sample.group, sample.code)

      if (baseline.group === 'previously-failed') {
        expect(baseline.legacyParsed).toBe(false)
      }

      const drift: string[] = []
      if (current.verdict !== baseline.verdict) drift.push(`verdict: ${baseline.verdict} -> ${current.verdict}`)
      if (JSON.stringify(current.patterns) !== JSON.stringify(baseline.patterns)) {
        drift.push(`patterns: ${JSON.stringify(baseline.patterns)} -> ${JSON.stringify(current.patterns)}`)
      }
      if ((current.reason ?? null) !== (baseline.reason ?? null)) {
        drift.push(`reason: ${baseline.reason ?? null} -> ${current.reason ?? null}`)
      }
      if (JSON.stringify(current.signals) !== JSON.stringify(baseline.signals)) {
        drift.push(`signals: ${JSON.stringify(baseline.signals)} -> ${JSON.stringify(current.signals)}`)
      }

      if (drift.length > 0) {
        // P1-7 评审修复：硬禁令不可被白名单豁免——非 A-fail 基线的 verdict 弱化
        //（真实危险识别不得降级；A-fail 是解析失败兜底，其消失属改善可登记）。
        const rank: Record<string, number> = { allow: 0, ask: 1, deny: 2 }
        const isAFailBaseline = baseline.patterns.includes('A-fail')
        if (
          !isAFailBaseline &&
          (rank[current.verdict] ?? 1) < (rank[baseline.verdict] ?? 1)
        ) {
          throw new Error(`Golden HARD-FAIL for ${sample.id}: 非 A-fail 基线 verdict 弱化（禁止，白名单不可豁免）: ${baseline.verdict} -> ${current.verdict}`)
        }
        const accepted = ACCEPTED_DRIFT[sample.id]
        if (accepted) {
          console.warn(`[scriptGolden] accepted drift for ${sample.id}: ${drift.join('; ')} — ${accepted}`)
          return
        }
        throw new Error(`Golden drift for ${sample.id}（未经评审登记）: ${drift.join('; ')}`)
      }
    })
  }
})
