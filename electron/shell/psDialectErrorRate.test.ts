// P3-T1：PowerShell 方言样本分层 ERROR 门禁。
// Tier-1 常见形态（日常命令）：ERROR 率必须 = 0（任何一条 ERROR 都意味着日常命令落确认卡）；
// Tier-2 扩展方言（边角构造）：ERROR 率 ≤ 5%；超限触发阶段评审（vendor/fork 预案）。
// 每条 ERROR 样本登记「合法脚本误报 → ask 兜底（fail-closed）」并计入上游缺陷跟踪。
import fs from 'node:fs'
import path from 'node:path'
import { scriptParserService, resetScriptParserServiceForTests } from './scriptParserService'

const GOLDEN_DIR = path.resolve(__dirname, 'testdata/golden/shell')

describe('psDialectErrorRate（P3-T1 分层 ERROR 门禁）', () => {
  beforeAll(async () => {
    resetScriptParserServiceForTests()
    await scriptParserService.ensureInitialized()
  })

  const manifest = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, 'manifest.json'), 'utf8')) as {
    samples: Array<{ id: string; dialect: string; tier?: number }>
  }
  const psSamples = manifest.samples.filter((s) => s.dialect === 'windows-powershell')

  it('分层样本规模：Tier-1 ≥ 20、Tier-2 ≥ 20', () => {
    expect(psSamples.filter((s) => s.tier === 1).length).toBeGreaterThanOrEqual(20)
    expect(psSamples.filter((s) => s.tier === 2).length).toBeGreaterThanOrEqual(20)
  })

  it('Tier-1 ERROR 率 = 0（常见形态零容忍）', () => {
    const failures: string[] = []
    for (const s of psSamples.filter((x) => x.tier === 1)) {
      const code = fs.readFileSync(path.join(GOLDEN_DIR, `${s.id}.txt`), 'utf8')
      const outcome = scriptParserService.parse('powershell', code)
      if (!outcome.ok) failures.push(s.id)
    }
    expect(failures, `Tier-1 ERROR 样本（合法命令误报 → ask 兜底；登记上游缺陷）: ${failures.join(', ')}`).toEqual([])
  })

  it('Tier-2 ERROR 率 ≤ 5%', () => {
    const tier2 = psSamples.filter((x) => x.tier === 2)
    const failures: string[] = []
    for (const s of tier2) {
      const code = fs.readFileSync(path.join(GOLDEN_DIR, `${s.id}.txt`), 'utf8')
      const outcome = scriptParserService.parse('powershell', code)
      if (!outcome.ok) failures.push(s.id)
    }
    const rate = failures.length / tier2.length
    expect(rate, `Tier-2 ERROR 率 ${(rate * 100).toFixed(1)}% > 5%，触发阶段评审（vendor/fork 预案）；样本: ${failures.join(', ')}`).toBeLessThanOrEqual(0.05)
  })
})
