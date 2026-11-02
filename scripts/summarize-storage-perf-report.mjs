import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const CASES = [
  { testName: 'paired warm API shadow', matches: ['keeps paired warm API shadow p95'] },
  { testName: 'canonical API selector', matches: ['measures the canonical API selector'] },
  { testName: 'warm L1 projection', matches: ['keeps warm L1 projection latency'] },
  { testName: 'file-backed cold C-scope', matches: ['measures file-backed cold C-scope visits'] },
  { testName: 'file-backed reopen reads', matches: ['measures file-backed prepared reads across same-object database reopen'] },
  { testName: 'file-backed projection backfill', matches: ['measures file-backed reads and canonical writes during projection backfill'] },
  { testName: 'canonical multi-spill', matches: ['records canonical-only prepared multi-spill latency'] },
  { testName: 'multi-session global search', matches: ['measures prepared canonical global search across multiple sessions'] },
  { testName: 'global search broken-candidate limit', matches: ['global search limit does not visit a broken canonical candidate'] }
]

function conclusion(status) {
  if (status === 'passed') return 'passed'
  if (status === 'failed') return 'failed'
  if (status === 'pending' || status === 'skipped' || status === 'todo') return 'skipped'
  return 'not-reported'
}

export function summarizeStoragePerfReport(report) {
  const assertions = (Array.isArray(report?.testResults) ? report.testResults : [])
    .flatMap((file) => Array.isArray(file?.assertionResults) ? file.assertionResults : [])
  return CASES.flatMap((entry) => {
    const matches = assertions.filter((assertion) => entry.matches.some((pattern) => String(assertion?.fullName ?? assertion?.title ?? '').includes(pattern)))
    if (!matches.length) return [{ testName: entry.testName, elapsedMs: null, conclusion: 'not-reported' }]
    return matches.map((assertion, index) => ({
      testName: matches.length === 1 ? entry.testName : `${entry.testName} #${index + 1}`,
      elapsedMs: Number.isFinite(assertion.duration) ? assertion.duration : null,
      conclusion: conclusion(assertion.status)
    }))
  })
}

function main() {
  const reportPath = process.env.STORAGE_PERF_REPORT_PATH ?? '.ci/storage-perf-report.json'
  const outputPath = process.env.STORAGE_PERF_SUMMARY_PATH ?? '.ci/storage-perf-summary.json'
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : undefined
  const summary = summarizeStoragePerfReport(report)
  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`Storage performance evidence: ${summary.length} selected records → ${outputPath}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
