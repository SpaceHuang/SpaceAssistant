import { readFile } from 'node:fs/promises'
import YAML from 'yaml'

export const REQUIRED_JOBS = Object.freeze({
  test: { name: 'CI / Full tests (macOS)', runner: 'macos-latest' },
  golden_windows: { name: 'CI / Shell golden (Windows)', runner: 'windows-latest' },
  sqlite_windows_x64: { name: 'CI / SQLite probe (Windows x64)', runner: 'windows-latest' },
  sqlite_macos_x64: { name: 'CI / SQLite probe (macOS x64)', runner: 'macos-15-intel' },
  sqlite_macos_arm64: { name: 'CI / SQLite probe (macOS arm64)', runner: 'macos-latest' },
  shell_windows_x64: { name: 'CI / Shell contract (Windows x64)', runner: 'windows-latest' },
  shell_macos_x64: { name: 'CI / Shell contract (macOS x64)', runner: 'macos-15-intel' },
  shell_macos_arm64: { name: 'CI / Shell contract (macOS arm64)', runner: 'macos-latest' }
})

const AGGREGATOR_ID = 'ci-required'
const LEGACY_MATRIX_JOBS = ['sqlite-electron-probe', 'shell-contract']

function values(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value]
}

export function checkWorkflow(workflow) {
  const issues = []
  const jobs = workflow?.jobs
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return ['jobs must be a mapping']

  for (const jobId of Object.keys(REQUIRED_JOBS)) {
    if (!Object.hasOwn(jobs, jobId)) issues.push(`missing required job ${jobId}`)
  }
  for (const oldId of LEGACY_MATRIX_JOBS) {
    if (Object.hasOwn(jobs, oldId)) issues.push(`legacy matrix job ${oldId} must be removed`)
  }
  for (const jobId of Object.keys(jobs)) {
    if (jobId !== AGGREGATOR_ID && !Object.hasOwn(REQUIRED_JOBS, jobId)) {
      issues.push(`unexpected job ${jobId} is outside the required coverage set`)
    }
  }

  const names = new Map()
  for (const [jobId, job] of Object.entries(jobs)) {
    if (job?.name) {
      if (names.has(job.name)) issues.push(`duplicate job display name ${job.name}: ${names.get(job.name)} and ${jobId}`)
      else names.set(job.name, jobId)
    }
  }

  for (const [jobId, expected] of Object.entries(REQUIRED_JOBS)) {
    const job = jobs[jobId]
    if (!job) continue
    if (job.name !== expected.name) issues.push(`${jobId} name must be ${expected.name}`)
    if (job['runs-on'] !== expected.runner) issues.push(`${jobId} runs-on must be ${expected.runner}`)
    if (job.strategy?.matrix) issues.push(`${jobId} must not use a matrix`)
  }

  const aggregator = jobs[AGGREGATOR_ID]
  if (!aggregator) {
    issues.push(`missing aggregator job ${AGGREGATOR_ID}`)
    return issues
  }
  if (aggregator.name !== 'required') issues.push(`${AGGREGATOR_ID} name must be required`)
  if (aggregator['if'] !== 'always()') issues.push(`${AGGREGATOR_ID} must use if: always()`)
  const dependencies = values(aggregator.needs)
  const dependencySet = new Set(dependencies)
  for (const duplicate of dependencies.filter((id, index) => dependencies.indexOf(id) !== index)) {
    issues.push(`duplicate aggregator dependency ${duplicate}`)
  }
  for (const jobId of Object.keys(REQUIRED_JOBS)) {
    if (!dependencySet.has(jobId)) issues.push(`aggregator is missing dependency ${jobId}`)
  }
  for (const jobId of dependencies) {
    if (!Object.hasOwn(REQUIRED_JOBS, jobId)) issues.push(`aggregator has unexpected dependency ${jobId}`)
  }
  return issues
}

async function main() {
  const workflowPath = new URL('../.github/workflows/ci.yml', import.meta.url)
  const source = await readFile(workflowPath, 'utf8')
  const workflow = YAML.parse(source)
  const issues = checkWorkflow(workflow)
  if (issues.length) {
    console.error('CI required coverage check failed:')
    for (const issue of issues) console.error(`- ${issue}`)
    process.exitCode = 1
    return
  }
  console.log(`CI required coverage check passed (${Object.keys(REQUIRED_JOBS).length} jobs).`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`CI required coverage check could not read workflow: ${error.message}`)
    process.exitCode = 1
  })
}
