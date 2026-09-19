// P2-T5 辅助：导出 Shell Golden 的完整 drift 清单（JSON），供评审文档逐条登记。
import fs from 'node:fs'
import path from 'node:path'
import { analyzeShellCommand } from '../electron/shell/analyzeShellCommand'
import { analyzeShellFacts } from '../electron/shell/shellAnalyzer'
import { normalizeShellSignature } from '../electron/confirmation/extractors/commandSequenceExtractor'
import { parseShellCommandForTrust, commandHasShellMetasyntax } from '../electron/shell/shellCommandParser'
import { precheckRunShellTool } from '../electron/shell/shellToolLoopHelpers'
import { scriptParserService } from '../electron/shell/scriptParserService'
import type { ShellConfig } from '../src/shared/domainTypes'

const GOLDEN_DIR = path.resolve('electron/shell/testdata/golden/shell')
const WORK_DIR = 'WORKDIR'
const USER_DATA_DIR = 'USERDATADIR'

function platformFor(dialect: string): NodeJS.Platform {
  return dialect === 'posix-bash' ? 'linux' : 'win32'
}

async function precheckOn(dialect: string, code: string, shellConfig: ShellConfig | null) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platformFor(dialect) })
  try {
    return await precheckRunShellTool({ command: code, workDir: WORK_DIR, userDataDir: USER_DATA_DIR, shellConfig })
  } finally {
    if (desc) Object.defineProperty(process, 'platform', desc)
  }
}

function norm(v: unknown): unknown {
  if (typeof v === 'string') return v.split(WORK_DIR).join('<WORKDIR>').split(USER_DATA_DIR).join('<USERDATA>')
  if (Array.isArray(v)) return v.map(norm)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]))
  return v
}

await scriptParserService.ensureInitialized()

const manifest = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, 'manifest.json'), 'utf8'))
const rows: Array<Record<string, unknown>> = []
for (const { id, dialect } of manifest.samples as Array<{ id: string; dialect: string }>) {
  const baseline = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, `${id}.json`), 'utf8'))
  const code = fs.readFileSync(path.join(GOLDEN_DIR, `${id}.txt`), 'utf8')
  const analysis = norm(JSON.parse(JSON.stringify(await analyzeShellCommand(WORK_DIR, code, platformFor(dialect), null, USER_DATA_DIR))))
  const trust = parseShellCommandForTrust(code, commandHasShellMetasyntax)
  const signature = { normalized: normalizeShellSignature(code), trust, persistableSingle: trust.persistable }
  const facts = norm(JSON.parse(JSON.stringify(analyzeShellFacts(code, dialect as never))))
  const precheck = await precheckOn(dialect, code, null)
  const precheckCur = precheck.ok
    ? { ok: true, legacyAutoAllowEligible: precheck.legacyAutoAllowEligible, analysisCompleteness: precheck.analysis.facts?.analysisCompleteness ?? null, persistable: trust.persistable, hasMetasyntax: trust.hasMetasyntax }
    : { ok: false, auditReason: precheck.auditReason }

  const drift: Record<string, unknown> = {}
  if (JSON.stringify(analysis) !== JSON.stringify(baseline.analysis)) drift.analysis = { baseline: baseline.analysis, current: analysis }
  if (JSON.stringify(signature) !== JSON.stringify(baseline.signature)) drift.signature = { baseline: baseline.signature, current: signature }
  if (JSON.stringify(facts) !== JSON.stringify(baseline.facts)) drift.facts = { baseline: baseline.facts, current: facts }
  if (JSON.stringify(precheckCur) !== JSON.stringify(baseline.precheck)) drift.precheck = { baseline: baseline.precheck, current: precheckCur }
  if (Object.keys(drift).length > 0) rows.push({ id, dialect, drift })
}
fs.mkdirSync('docs/develop/golden-data', { recursive: true })
fs.writeFileSync('docs/develop/golden-data/shell-drift-after-switch.json', JSON.stringify(rows, null, 2) + '\n')
const bashFactsFlipped = rows.filter((r) => r.dialect === 'posix-bash' && String(JSON.stringify(r.drift)).includes('"analysisCompleteness":"partial"') === false && String(JSON.stringify((r.drift as { facts?: { baseline?: { analysisCompleteness?: string } } }).facts?.baseline)).includes('"partial"') && String(JSON.stringify((r.drift as { facts?: { current?: { analysisCompleteness?: string } } }).facts?.current)).includes('"complete"'))
console.log('total drifts:', rows.length)
console.log('facts partial->complete flipped (bash):', bashFactsFlipped.length)
