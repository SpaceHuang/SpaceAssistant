export const REQUIRED_RESULTS = Object.freeze({
  test: 'macOS',
  golden_windows: 'Windows',
  sqlite_windows_x64: 'Windows x64',
  sqlite_macos_x64: 'macOS x64',
  sqlite_macos_arm64: 'macOS arm64',
  shell_windows_x64: 'Windows x64',
  shell_macos_x64: 'macOS x64',
  shell_macos_arm64: 'macOS arm64'
})

export function summarizeResults(needs) {
  const failed = []
  for (const [jobId, platform] of Object.entries(REQUIRED_RESULTS)) {
    const result = needs?.[jobId]?.result
    if (result !== 'success') failed.push({ jobId, platform, result: typeof result === 'string' ? result : 'missing' })
  }
  return { success: failed.length === 0, failed }
}

export function formatResultSummary(needs, { commitSha = 'unknown', runId = 'unknown', runAttempt = 'unknown', actionsUrl = '' } = {}) {
  const summary = summarizeResults(needs)
  const lines = [`CI required summary for commit ${commitSha}, run ${runId}, attempt ${runAttempt}`]
  if (actionsUrl) {
    lines.push(`Run details: ${actionsUrl}`)
    lines.push(`Attempt details: ${actionsUrl}/attempts/${runAttempt}`)
  }
  for (const [jobId, platform] of Object.entries(REQUIRED_RESULTS)) {
    const result = needs?.[jobId]?.result
    lines.push(`${jobId} (${platform}): ${typeof result === 'string' ? result : 'missing'}`)
  }
  if (!summary.success) {
    lines.push(`CI required failed: ${summary.failed.map(({ jobId, platform, result }) => `${jobId} (${platform})=${result}`).join(', ')}`)
  }
  return { summary, output: lines.join('\n') }
}

function main() {
  const needs = JSON.parse(process.env.NEEDS_JSON ?? '{}')
  const result = formatResultSummary(needs, {
    commitSha: process.env.COMMIT_SHA ?? 'unknown',
    runId: process.env.RUN_ID ?? 'unknown',
    runAttempt: process.env.RUN_ATTEMPT ?? 'unknown',
    actionsUrl: process.env.ACTIONS_URL ?? ''
  })
  console.log(result.output)
  if (!result.summary.success) {
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main()
  } catch (error) {
    console.error(`CI required result summary could not be evaluated: ${error.message}`)
    process.exitCode = 1
  }
}
