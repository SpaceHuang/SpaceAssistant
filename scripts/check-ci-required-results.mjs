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

function main() {
  const needs = JSON.parse(process.env.NEEDS_JSON ?? '{}')
  const summary = summarizeResults(needs)
  const commitSha = process.env.COMMIT_SHA ?? 'unknown'
  const runId = process.env.RUN_ID ?? 'unknown'
  const runAttempt = process.env.RUN_ATTEMPT ?? 'unknown'
  const actionsUrl = process.env.ACTIONS_URL ?? ''

  console.log(`CI required summary for commit ${commitSha}, run ${runId}, summary attempt ${runAttempt}`)
  if (actionsUrl) console.log(`Run details: ${actionsUrl}`)
  for (const [jobId, platform] of Object.entries(REQUIRED_RESULTS)) {
    const result = needs?.[jobId]?.result
    console.log(`${jobId} (${platform}): ${typeof result === 'string' ? result : 'missing'}`)
  }
  if (!summary.success) {
    console.error(`CI required failed: ${summary.failed.map(({ jobId, platform, result }) => `${jobId} (${platform})=${result}`).join(', ')}`)
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
