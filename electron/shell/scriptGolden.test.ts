// Python Golden：脚本分析 findings 回归基线。Policy 动作另由策略矩阵测试覆盖。
import fs from 'node:fs'
import path from 'node:path'
import { analyzeScriptContent } from './scriptContentSecurity'

const GOLDEN_DIR = path.resolve(__dirname, 'testdata', 'golden', 'python')

type GoldenBaseline = {
  id: string
  group: 'legacy-parseable' | 'previously-failed'
  patternIds: string[]
  coverage: 'complete' | 'failed' | 'partial'
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
  const analysis = analyzeScriptContent(code)
  return {
    id,
    group,
    patternIds: [...new Set(analysis.findings.map((finding) => finding.pattern))].sort(),
    coverage: analysis.coverage
  }
}

describe('scriptGolden（Python findings 基线）', () => {
  const samples = loadSamples()

  it('样本集规模 ≥ 80 且 id 唯一', () => {
    expect(samples.length).toBeGreaterThanOrEqual(80)
    expect(new Set(samples.map((s) => s.id)).size).toBe(samples.length)
    expect(samples.filter((s) => s.group === 'legacy-parseable').length).toBeGreaterThanOrEqual(40)
    expect(samples.filter((s) => s.group === 'previously-failed').length).toBeGreaterThanOrEqual(30)
  })

  it('每个已产出的首批 finding 均有有效位置且片段与源码逐字节对应', () => {
    for (const sample of samples) {
      const result = analyzeScriptContent(sample.code)
      expect(result.totalCount).toBe(result.findings?.length)
      for (const finding of result.findings ?? []) {
        const { range } = finding
        expect(range.startLine).toBeGreaterThan(0)
        expect(range.startCol).toBeGreaterThan(0)
        expect(range.endLine).toBeGreaterThanOrEqual(range.startLine)
        expect(range.endCol).toBeGreaterThan(0)
        const lines = sample.code.split('\n')
        const first = range.startLine - 1
        const last = range.endLine - 1
        const sliceBytes = (line: string, start: number, end: number) => Buffer.from(line, 'utf8').subarray(start, end).toString('utf8')
        const expected = first === last
          ? sliceBytes(lines[first]!, range.startCol - 1, range.endCol - 1)
          : [sliceBytes(lines[first]!, range.startCol - 1, Buffer.byteLength(lines[first]!, 'utf8')),
            ...lines.slice(first + 1, last), sliceBytes(lines[last]!, 0, range.endCol - 1)].join('\n')
        expect(finding.snippet).toBe(expected)
      }
    }
  })

  it.each(samples)('$id：finding 与基线一致', (sample) => {
    const baselinePath = path.join(GOLDEN_DIR, `${sample.id}.json`)
    expect(fs.existsSync(baselinePath)).toBe(true)
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as GoldenBaseline
    const current = snapshotOf(sample.id, sample.group, sample.code)

    expect(current.coverage).toBe('complete')
    expect(current.patternIds).toEqual(baseline.patternIds)
  })
})
