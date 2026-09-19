// P1-T5 辅助：导出「切换后实现 vs 基线」的完整 drift 清单（JSON），供 Golden 评审文档登记。
import fs from 'node:fs'
import path from 'node:path'
import { analyzeScriptContent, parsePythonModule } from '../electron/shell/scriptContentSecurity'
import { extractScriptSignals } from '../electron/confirmation/extractors/scriptAnalysisExtractor'

import { scriptParserService } from '../electron/shell/scriptParserService'

const GOLDEN_DIR = path.resolve('electron/shell/testdata/golden/python')
const manifest = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, 'manifest.json'), 'utf8'))

await scriptParserService.ensureInitialized()

const rows = []
for (const { id, group } of manifest.samples) {
  const baseline = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, `${id}.json`), 'utf8'))
  const code = fs.readFileSync(path.join(GOLDEN_DIR, `${id}.py`), 'utf8')
  const current = { id, group, legacyParsed: baseline.legacyParsed }
  try {
    const analysis = analyzeScriptContent(code, {})
    current.verdict = analysis.verdict
    current.patterns = analysis.patterns
    current.reason = analysis.reason ?? null
    current.signals = JSON.parse(JSON.stringify(extractScriptSignals(code, {}).signals))
  } catch (err) {
    current.verdict = 'THREW'
    current.error = String(err && err.message)
  }
  const drift = []
  if (current.verdict !== baseline.verdict) drift.push(['verdict', baseline.verdict, current.verdict])
  if (JSON.stringify(current.patterns) !== JSON.stringify(baseline.patterns)) drift.push(['patterns', baseline.patterns, current.patterns])
  if ((current.reason ?? null) !== (baseline.reason ?? null)) drift.push(['reason', baseline.reason ?? null, current.reason ?? null])
  if (JSON.stringify(current.signals) !== JSON.stringify(baseline.signals)) drift.push(['signals', baseline.signals, current.signals])
  if (drift.length > 0) rows.push({ id, group, drift: Object.fromEntries(drift.map(([k, b, c]) => [k, { baseline: b, current: c }])) })
}
fs.mkdirSync('docs/develop/golden-data', { recursive: true })
fs.writeFileSync('docs/develop/golden-data/python-drift-after-switch.json', JSON.stringify(rows, null, 2) + '\n')
console.log(`total samples drifts: ${rows.length}`)
const byGroup = {}
for (const r of rows) byGroup[r.group] = (byGroup[r.group] ?? 0) + 1
console.log(JSON.stringify(byGroup))
