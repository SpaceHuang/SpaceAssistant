import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const SECRET_PATTERNS = [
  /\bBearer\s+[^\s,;]+/gi,
  /\b(?:api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:xox[baprs]-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+/gi,
  /https?:\/\/[^\s?#]+(?:\?[^\s#]*)?/gi,
  /"[^"\n]*"|'[^'\n]*'/g
]

function redact(value) {
  let safe = String(value ?? '')
  for (const pattern of SECRET_PATTERNS) safe = safe.replace(pattern, '[REDACTED]')
  return safe.slice(0, 1200)
}

function relativeFile(file, workspace = process.cwd()) {
  const normalized = String(file ?? '').replaceAll('\\', '/')
  const normalizedWorkspace = String(workspace ?? '').replaceAll('\\', '/').replace(/\/$/, '')
  const workspacePrefix = `${normalizedWorkspace}/`
  if (normalized.toLowerCase().startsWith(workspacePrefix.toLowerCase())) return normalized.slice(workspacePrefix.length)
  const marker = '/SpaceAssistant/'
  const markerIndex = normalized.lastIndexOf(marker)
  return markerIndex >= 0 ? normalized.slice(markerIndex + marker.length) : path.basename(normalized)
}

export function summarizeVitestReport(report, { platform, nodeVersion, commitSha, runUrl, workspace = process.cwd() }) {
  const counts = { passed: 0, failed: 0, skipped: 0, other: 0 }
  const failedTests = []
  for (const file of Array.isArray(report?.testResults) ? report.testResults : []) {
    const assertions = Array.isArray(file?.assertionResults) ? file.assertionResults : []
    let hasAssertionFailure = false
    for (const assertion of assertions) {
      const status = assertion?.status
      if (status === 'passed') counts.passed += 1
      else if (status === 'failed') {
        hasAssertionFailure = true
        counts.failed += 1
        failedTests.push({
          file: relativeFile(file.name, workspace),
          name: redact(assertion.fullName ?? assertion.title ?? 'unnamed test'),
          status,
          durationMs: Number.isFinite(assertion.duration) ? assertion.duration : null,
          error: redact((assertion.failureMessages ?? []).join('\n').split('\n').find((line) => line.trim() && !line.trim().startsWith('at ')) ?? '')
        })
      } else if (status === 'pending' || status === 'skipped' || status === 'todo') counts.skipped += 1
      else counts.other += 1
    }
    if (file?.status === 'failed' && !hasAssertionFailure) {
      counts.failed += 1
      const message = String(file.message ?? file.failureMessage ?? '')
      failedTests.push({
        file: relativeFile(file.name, workspace),
        name: 'test file failed to load',
        status: 'failed',
        durationMs: Number.isFinite(file.duration) ? file.duration : Number.isFinite(file.startTime) && Number.isFinite(file.endTime) ? file.endTime - file.startTime : null,
        error: redact(message.split('\n').find((line) => line.trim() && !line.trim().startsWith('at ')) ?? '')
      })
    }
  }
  return { platform, nodeVersion, commitSha, runUrl, counts, failedTests }
}

function main() {
  const reportPath = process.env.VITEST_REPORT_PATH ?? '.ci/vitest-report.json'
  const outputPath = process.env.VITEST_SUMMARY_PATH ?? '.ci/vitest-summary.json'
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const platform = process.env.CI_PLATFORM ?? `${process.platform} ${process.arch}`
  const commitSha = process.env.GITHUB_SHA ?? 'local'
  const runUrl = process.env.ACTIONS_URL ?? ''
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd()
  const summary = summarizeVitestReport(report, { platform, nodeVersion: process.version, commitSha, runUrl, workspace })
  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`Vitest evidence: SHA ${commitSha} | ${runUrl || 'local run'} | runner ${platform} | Node ${process.version}`)
  console.log(`Vitest: ${summary.counts.passed} passed, ${summary.counts.failed} failed, ${summary.counts.skipped} skipped`)
  for (const failure of summary.failedTests) console.error(`FAILED ${failure.file}: ${failure.name} (${failure.durationMs ?? 'unknown'}ms): ${failure.error}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main() } catch (error) {
    console.error(`Vitest report summary failed: ${redact(error.message)}`)
    process.exitCode = 1
  }
}
