import { readFile } from 'node:fs/promises'

export const FAILURE_CATEGORIES = Object.freeze([
  'code-contract',
  'test-fixture',
  'platform',
  'toolchain-runner',
  'concurrency-resource',
  'external-dependency'
])

function timestamp(value, field, { optional = false } = {}) {
  if (optional && value == null) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be a valid ISO timestamp`)
  return parsed
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const value = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  return Math.round(value * 100) / 100
}

function validateAndSortRuns(mainRuns) {
  if (!Array.isArray(mainRuns) || mainRuns.length === 0) throw new Error('mainRuns must be a non-empty array')
  const seen = new Set()
  for (const run of mainRuns) {
    if (typeof run?.runId !== 'string' || !run.runId || seen.has(run.runId)) throw new Error('mainRuns must have unique runId values')
    if (run.branch !== 'main') throw new Error(`run ${run.runId} must be from main`)
    if (!['success', 'failure', 'cancelled', 'skipped'].includes(run.conclusion)) throw new Error(`run ${run.runId} has an invalid conclusion`)
    timestamp(run.createdAt, `mainRuns.${run.runId}.createdAt`)
    if (typeof run.url !== 'string' || !/^https:\/\/github\.com\//.test(run.url)) throw new Error(`run ${run.runId} must have a GitHub Actions URL`)
    seen.add(run.runId)
  }
  return [...mainRuns].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

function validateReviews(reviews, runIds) {
  if (!Array.isArray(reviews)) throw new Error('reviews must be an array')
  const seen = new Set()
  for (const review of reviews) {
    if (typeof review?.incidentId !== 'string' || !review.incidentId || seen.has(review.incidentId)) throw new Error('reviews must have unique incidentId values')
    if (!runIds.has(review.runId)) throw new Error(`review ${review.incidentId} must reference a listed main run`)
    if (!FAILURE_CATEGORIES.includes(review.category)) throw new Error(`review ${review.incidentId} has an invalid category`)
    if (typeof review.rootCauseId !== 'string' || !review.rootCauseId || typeof review.rootCause !== 'string' || !review.rootCause.trim()) throw new Error(`review ${review.incidentId} needs a root cause`)
    const firstFailure = timestamp(review.firstFailureAt, `review ${review.incidentId}.firstFailureAt`)
    const located = timestamp(review.locatedAt, `review ${review.incidentId}.locatedAt`, { optional: true })
    const fixed = timestamp(review.fixedAt, `review ${review.incidentId}.fixedAt`, { optional: true })
    if (located != null && located < firstFailure) throw new Error(`review ${review.incidentId}.locatedAt cannot precede firstFailureAt`)
    if (fixed != null && (located == null || fixed < located)) throw new Error(`review ${review.incidentId}.fixedAt must follow locatedAt`)
    if (review.rerunOnlyClosure === true) throw new Error(`review ${review.incidentId}: rerun alone cannot close a failure review`)
    if (fixed != null && (!review.fixCommit || !review.verificationRunId || !review.closureEvidence?.trim())) {
      throw new Error(`review ${review.incidentId} needs a fix commit, verification run and closure evidence`)
    }
    if (fixed == null && (review.fixCommit || review.verificationRunId || review.closureEvidence)) {
      throw new Error(`review ${review.incidentId} cannot record closure evidence before fixedAt`)
    }
    seen.add(review.incidentId)
  }
}

export function summarizeFailureReview(input) {
  const mainRuns = validateAndSortRuns(input?.mainRuns)
  const runsById = new Map(mainRuns.map((run) => [run.runId, run]))
  validateReviews(input?.reviews, new Set(runsById.keys()))

  const recentFailures = mainRuns[0]?.conclusion === 'failure' && mainRuns[1]?.conclusion === 'failure'
    ? [mainRuns[0], mainRuns[1]]
    : []
  const reviews = input.reviews
  for (const run of recentFailures) {
    if (!reviews.some((review) => review.runId === run.runId)) throw new Error(`consecutive main failure ${run.runId} has no review entry`)
  }
  const categoryCounts = {}
  const causes = new Map()
  const diagnosisMinutes = []
  const fixMinutes = []
  let unresolvedCount = 0

  for (const review of reviews) {
    categoryCounts[review.category] = (categoryCounts[review.category] ?? 0) + 1
    causes.set(review.rootCauseId, (causes.get(review.rootCauseId) ?? 0) + 1)
    const failureTime = Date.parse(review.firstFailureAt)
    if (review.locatedAt) diagnosisMinutes.push((Date.parse(review.locatedAt) - failureTime) / 60_000)
    if (review.fixedAt) fixMinutes.push((Date.parse(review.fixedAt) - failureTime) / 60_000)
    else unresolvedCount += 1
  }

  return {
    twoConsecutiveMainFailures: recentFailures.length === 2,
    triggerRunIds: recentFailures.map(({ runId }) => runId),
    incidentCount: reviews.length,
    categoryCounts,
    diagnosisMedianMinutes: median(diagnosisMinutes),
    diagnosisMeasuredCount: diagnosisMinutes.length,
    fixMedianMinutes: median(fixMinutes),
    fixMeasuredCount: fixMinutes.length,
    unresolvedCount,
    repeatedRootCauses: [...causes].filter(([, count]) => count > 1).map(([rootCauseId, count]) => ({ rootCauseId, count })),
    incidents: reviews.map((review) => ({ ...review, runUrl: runsById.get(review.runId).url }))
  }
}

export function renderFailureReview(summary) {
  const formatMinutes = (value, count) => value == null ? `尚无已定位样本（${count}）` : `${value} 分钟（${count} 个样本）`
  const lines = [
    '# CI 失败复盘汇总',
    '',
    `- 连续两次 main 失败触发：${summary.twoConsecutiveMainFailures ? '是' : '否'}`,
    `- 复盘事件：${summary.incidentCount}；未关闭：${summary.unresolvedCount}`,
    `- 从首次失败到定位的中位数：${formatMinutes(summary.diagnosisMedianMinutes, summary.diagnosisMeasuredCount)}`,
    `- 从首次失败到修复的中位数：${formatMinutes(summary.fixMedianMinutes, summary.fixMeasuredCount)}`,
    '',
    '## 分类'
  ]
  for (const [category, count] of Object.entries(summary.categoryCounts)) lines.push(`- ${category}: ${count}`)
  lines.push('', '## 重复根因')
  if (summary.repeatedRootCauses.length === 0) lines.push('- 暂无重复根因')
  else for (const cause of summary.repeatedRootCauses) lines.push(`- ${cause.rootCauseId}: ${cause.count} 次`)
  lines.push('', '## 事件')
  for (const incident of summary.incidents) {
    const fixed = incident.fixedAt ? `修复 ${incident.fixedAt}（${incident.fixCommit}）` : '未关闭；重跑变绿不能代替根因修复'
    lines.push(`- [${incident.runId}](${incident.runUrl}) · ${incident.category} · ${incident.rootCause} · 定位 ${incident.locatedAt ?? '未定位'} · ${fixed}`)
  }
  return `${lines.join('\n')}\n`
}

async function main() {
  const inputPath = process.argv[2] ?? new URL('../docs/develop/platform-eng/ci-failure-reviews.json', import.meta.url)
  const input = JSON.parse(await readFile(inputPath, 'utf8'))
  const summary = summarizeFailureReview(input)
  process.stdout.write(renderFailureReview(summary))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`CI failure review failed: ${error.message}`)
    process.exitCode = 1
  })
}
