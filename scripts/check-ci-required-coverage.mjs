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
const OBSERVATION_JOBS = Object.freeze(['storage-perf', 'chat_business_probe'])

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
  for (const jobId of OBSERVATION_JOBS) {
    if (!Object.hasOwn(jobs, jobId)) issues.push(`missing observation job ${jobId}`)
  }
  for (const oldId of LEGACY_MATRIX_JOBS) {
    if (Object.hasOwn(jobs, oldId)) issues.push(`legacy matrix job ${oldId} must be removed`)
  }
  for (const jobId of Object.keys(jobs)) {
    if (jobId !== AGGREGATOR_ID && !Object.hasOwn(REQUIRED_JOBS, jobId) && !OBSERVATION_JOBS.includes(jobId)) {
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

  const testSteps = jobs.test?.steps ?? []
  const fullVitest = testSteps.find((step) => typeof step.run === 'string' && step.run.startsWith('npm test'))
  const prepareReports = testSteps.find((step) => step.name === 'Prepare Vitest report directory')
  const prepareIndex = testSteps.indexOf(prepareReports)
  const vitestIndex = testSteps.indexOf(fullVitest)
  if (prepareReports?.run !== 'mkdir -p .ci' || prepareIndex < 0 || vitestIndex < 0 || prepareIndex > vitestIndex) {
    issues.push('test report directory must be prepared before the full Vitest run')
  }
  if (!fullVitest?.run.includes('--reporter=dot') || !fullVitest?.run.includes('--reporter=json') || !fullVitest?.run.includes('--outputFile=.ci/vitest-report.json')) {
    issues.push('test job must emit a Vitest JSON report alongside dot output')
  }
  const summarizeStep = testSteps.find((step) => step.name === 'Summarize Vitest failures')
  if (summarizeStep?.run !== 'node scripts/summarize-vitest-report.mjs' || summarizeStep.if !== 'always()' || summarizeStep.env?.CI_PLATFORM !== 'macOS ${{ runner.arch }}' || !summarizeStep.env?.ACTIONS_URL) {
    issues.push('test job must always create the sanitized Vitest report summary')
  }
  const reportArtifact = testSteps.find((step) => step.name === 'Upload sanitized Vitest report')
  if (reportArtifact?.uses !== 'actions/upload-artifact@v5' || reportArtifact.if !== 'always()' || reportArtifact.with?.path !== '.ci/vitest-summary.json' || reportArtifact.with?.['retention-days'] !== 14 || reportArtifact.with?.['if-no-files-found'] !== 'error') {
    issues.push('test job must upload the sanitized Vitest report artifact with 14-day retention')
  }
  const testElectronInit = testSteps.find((step) => step.name === 'Initialize Electron binary before test workers' && step.run === 'node scripts/initialize-electron-ci.mjs')
  const testElectronInitIndex = testSteps.indexOf(testElectronInit)
  const vitestWorkerIndices = testSteps.map((step, index) => ({ step, index }))
    .filter(({ step }) => typeof step.run === 'string' && (step.run.includes('vitest run') || step.run.startsWith('npm test')))
    .map(({ index }) => index)
  if (testElectronInitIndex < 0 || vitestWorkerIndices.length === 0 || vitestWorkerIndices.some((index) => testElectronInitIndex > index)) {
    issues.push('test: Electron initialization must precede Vitest workers')
  }
  if (testSteps[testElectronInitIndex]?.['continue-on-error'] === true) issues.push('test: Electron initialization failure must stop the full test job')
  for (const jobId of ['shell_windows_x64', 'shell_macos_x64', 'shell_macos_arm64']) {
    const steps = jobs[jobId]?.steps ?? []
    const initIndex = steps.findIndex((step) => step.name === 'Initialize Electron binary before test workers' && step.run === 'node scripts/initialize-electron-ci.mjs')
    const workerIndices = steps.map((step, index) => ({ step, index }))
      .filter(({ step }) => typeof step.run === 'string' && (step.run.includes('vitest run') || step.run.includes('test:shell-lifecycle')))
      .map(({ index }) => index)
    if (initIndex < 0 || workerIndices.length === 0 || workerIndices.some((index) => initIndex > index)) {
      issues.push(`${jobId}: Electron initialization must precede shell test workers`)
    }
    if (steps[initIndex]?.['continue-on-error'] === true) issues.push(`${jobId}: Electron initialization failure must stop the shell job`)
  }

  const storagePerf = jobs['storage-perf']
  if (storagePerf) {
    if (storagePerf.name !== 'CI / Storage performance (observation)' || storagePerf['runs-on'] !== 'macos-latest' || storagePerf.strategy?.matrix) {
      issues.push('storage-perf must use the single macOS observation runner')
    }
    const steps = storagePerf.steps ?? []
    const buildIndex = steps.findIndex((step) => step.run === 'npm run build:agent-provider-pi-ai')
    const perfIndex = steps.findIndex((step) => step.run === 'npm run test:storage-perf -- --reporter=json --outputFile=.ci/storage-perf-report.json')
    const summary = steps.find((step) => step.name === 'Summarize selected storage performance results')
    const artifact = steps.find((step) => step.name === 'Upload sanitized storage performance summary')
    if (buildIndex < 0 || perfIndex < 0 || buildIndex > perfIndex) issues.push('storage-perf must build the provider before running its selected tests')
    if (summary?.run !== 'node scripts/summarize-storage-perf-report.mjs' || summary.if !== 'always()') issues.push('storage-perf must always create its sanitized summary')
    if (artifact?.uses !== 'actions/upload-artifact@v5' || artifact.if !== 'always()' || artifact.with?.path !== '.ci/storage-perf-summary.json' || artifact.with?.['retention-days'] !== 14) {
      issues.push('storage-perf must upload the sanitized 14-day summary artifact')
    }
  }

  const chatProbe = jobs.chat_business_probe
  if (chatProbe) {
    if (chatProbe.name !== 'CI / Chat business IPC probe (${{ matrix.label }})' || chatProbe['runs-on'] !== '${{ matrix.runner }}') {
      issues.push('chat_business_probe must be the platform matrix observation job')
    }
    const platforms = (chatProbe.strategy?.matrix?.include ?? []).map((item) => item.runner)
    if (!platforms.includes('macos-latest') || !platforms.includes('windows-latest')) issues.push('chat_business_probe must include macOS and Windows')
    if (chatProbe.env?.SPACEASSISTANT_IPC_SAMPLES !== 40) issues.push('chat_business_probe must set the bounded CI sample count')
    const steps = chatProbe.steps ?? []
    const buildIndex = steps.findIndex((step) => step.run === 'npm run build:electron')
    const initIndex = steps.findIndex((step) => step.name === 'Initialize Electron binary before probe' && step.run === 'node scripts/initialize-electron-ci.mjs')
    const probeIndex = steps.findIndex((step) => step.name === 'Probe chat IPC business lifecycle' && step.run === 'npm run probe:chat-business-ipc')
    if (buildIndex < 0 || buildIndex > initIndex || initIndex < 0 || initIndex > probeIndex || probeIndex < 0) {
      issues.push('chat_business_probe: Electron initialization must precede the probe after build')
    }
    if (steps[initIndex]?.['continue-on-error'] === true) issues.push('chat_business_probe: Electron initialization failure must stop the probe')
  }

  const aggregator = jobs[AGGREGATOR_ID]
  if (!aggregator) {
    issues.push(`missing aggregator job ${AGGREGATOR_ID}`)
    return issues
  }
  if (aggregator.name !== 'required') issues.push(`${AGGREGATOR_ID} name must be required`)
  if (aggregator['if'] !== 'always()') issues.push(`${AGGREGATOR_ID} must use if: always()`)
  if (!aggregator.steps?.some((step) => step.uses === 'actions/checkout@v5')) issues.push('aggregator must check out the repository before running its summary script')
  const dependencies = values(aggregator.needs)
  const dependencySet = new Set(dependencies)
  for (const jobId of OBSERVATION_JOBS) {
    if (dependencySet.has(jobId)) issues.push(`${AGGREGATOR_ID} must not depend on observational job ${jobId}`)
  }
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
