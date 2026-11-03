import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import YAML from 'yaml'
import { checkWorkflow } from './check-ci-required-coverage.mjs'

const workflow = YAML.parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
const requiredIds = ['test', 'golden_windows', 'sqlite_windows_x64', 'sqlite_macos_x64', 'sqlite_macos_arm64', 'shell_windows_x64', 'shell_macos_x64', 'shell_macos_arm64']
const displayNames = {
  test: 'CI / Full tests (macOS)',
  golden_windows: 'CI / Shell golden (Windows)',
  sqlite_windows_x64: 'CI / SQLite probe (Windows x64)',
  sqlite_macos_x64: 'CI / SQLite probe (macOS x64)',
  sqlite_macos_arm64: 'CI / SQLite probe (macOS arm64)',
  shell_windows_x64: 'CI / Shell contract (Windows x64)',
  shell_macos_x64: 'CI / Shell contract (macOS x64)',
  shell_macos_arm64: 'CI / Shell contract (macOS arm64)'
}
const runners = {
  test: 'macos-latest', golden_windows: 'windows-latest', sqlite_windows_x64: 'windows-latest',
  sqlite_macos_x64: 'macos-15-intel', sqlite_macos_arm64: 'macos-latest', shell_windows_x64: 'windows-latest',
  shell_macos_x64: 'macos-15-intel', shell_macos_arm64: 'macos-latest'
}

function validWorkflow() {
  const changed = structuredClone(workflow)
  for (const [id, job] of Object.entries(changed.jobs)) {
    if (displayNames[id]) job.name = displayNames[id]
  }
  return changed
}

test('accepts the complete required job set and matching aggregator dependencies', () => {
  assert.deepEqual(checkWorkflow(validWorkflow()), [])
})

test('rejects a missing platform job', () => {
  const changed = validWorkflow()
  delete changed.jobs.sqlite_macos_x64
  assert.ok(checkWorkflow(changed).some((issue) => issue.includes('sqlite_macos_x64')))
})

test('rejects a missing aggregator dependency', () => {
  const changed = validWorkflow()
  changed.jobs['ci-required'].needs = changed.jobs['ci-required'].needs.filter((id) => id !== 'shell_windows_x64')
  assert.ok(checkWorkflow(changed).some((issue) => issue.includes('shell_windows_x64')))
})

test('rejects removing a job and its aggregator dependency together', () => {
  const changed = validWorkflow()
  delete changed.jobs.shell_macos_arm64
  changed.jobs['ci-required'].needs = changed.jobs['ci-required'].needs.filter((id) => id !== 'shell_macos_arm64')
  assert.ok(checkWorkflow(changed).some((issue) => issue.includes('shell_macos_arm64')))
})

test('rejects duplicate display names and platform runner mismatches', () => {
  const duplicateName = validWorkflow()
  duplicateName.jobs.shell_windows_x64.name = duplicateName.jobs.shell_macos_x64.name
  assert.ok(checkWorkflow(duplicateName).some((issue) => issue.includes('duplicate')))

  const wrongRunner = validWorkflow()
  wrongRunner.jobs.sqlite_windows_x64['runs-on'] = 'ubuntu-latest'
  assert.ok(checkWorkflow(wrongRunner).some((issue) => issue.includes('sqlite_windows_x64')))
})

test('rejects legacy platform matrices and duplicate job identities', () => {
  const matrix = validWorkflow()
  matrix.jobs.shell_macos_x64.strategy = { matrix: { os: ['macos-15-intel'] } }
  assert.ok(checkWorkflow(matrix).some((issue) => issue.includes('matrix')))

  const duplicate = validWorkflow()
  duplicate.jobs.test.name = duplicate.jobs.golden_windows.name
  assert.ok(checkWorkflow(duplicate).some((issue) => issue.includes('duplicate')))
})

test('rejects an untracked extra job outside the fixed required set', () => {
  const changed = validWorkflow()
  changed.jobs.untracked_platform_check = { name: 'Extra check', 'runs-on': 'ubuntu-latest', steps: [] }
  assert.ok(checkWorkflow(changed).some((issue) => issue.includes('untracked_platform_check')))
})

test('requires a failure-safe sanitized Vitest report upload on the full test job', () => {
  const changed = validWorkflow()
  const steps = changed.jobs.test.steps
  assert.deepEqual(checkWorkflow(changed), [])

  const vitest = steps.find((step) => step.run?.startsWith('npm test'))
  vitest.run = 'npm test'
  assert.ok(checkWorkflow(changed).some((issue) => issue.includes('Vitest JSON report')))

  const complete = validWorkflow()
  complete.jobs.test.steps = complete.jobs.test.steps.filter((step) => step.name !== 'Prepare Vitest report directory')
  assert.ok(checkWorkflow(complete).some((issue) => issue.includes('report directory must be prepared')))

  const missingArtifact = validWorkflow()
  missingArtifact.jobs.test.steps = missingArtifact.jobs.test.steps.filter((step) => step.name !== 'Upload sanitized Vitest report')
  assert.ok(checkWorkflow(missingArtifact).some((issue) => issue.includes('sanitized Vitest report artifact')))
})

test('requires the result aggregator to check out the script it executes', () => {
  const changed = validWorkflow()
  changed.jobs['ci-required'].steps = changed.jobs['ci-required'].steps.filter((step) => step.uses !== 'actions/checkout@v5')
  assert.ok(checkWorkflow(changed).some((issue) => issue.includes('aggregator must check out the repository')))
})

test('requires Electron initialization before all shell test workers without continue-on-error', () => {
  const changed = validWorkflow()
  const shellJob = changed.jobs.shell_windows_x64
  const initIndex = shellJob.steps.findIndex((step) => step.name === 'Initialize Electron binary before test workers')
  const initStep = shellJob.steps.splice(initIndex, 1)[0]
  shellJob.steps.push(initStep)
  assert.ok(checkWorkflow(changed).some((issue) => issue.includes('Electron initialization must precede shell test workers')))

  const ignoredFailure = validWorkflow()
  const init = ignoredFailure.jobs.shell_macos_x64.steps.find((step) => step.name === 'Initialize Electron binary before test workers')
  init['continue-on-error'] = true
  assert.ok(checkWorkflow(ignoredFailure).some((issue) => issue.includes('Electron initialization failure must stop the shell job')))
})

test('requires Electron initialization before the full job starts any Vitest worker', () => {
  const changed = validWorkflow()
  const steps = changed.jobs.test.steps
  const initIndex = steps.findIndex((step) => step.name === 'Initialize Electron binary before test workers')
  const initStep = steps.splice(initIndex, 1)[0]
  steps.push(initStep)
  assert.ok(checkWorkflow(changed).some((issue) => issue.includes('test: Electron initialization must precede Vitest workers')))
})

test('tracks the observational chat business probe and protects its Electron initialization barrier', () => {
  assert.deepEqual(checkWorkflow(validWorkflow()), [])

  const missing = validWorkflow()
  delete missing.jobs.chat_business_probe
  assert.ok(checkWorkflow(missing).some((issue) => issue.includes('chat_business_probe')))

  const reordered = validWorkflow()
  const steps = reordered.jobs.chat_business_probe.steps
  const initIndex = steps.findIndex((step) => step.name === 'Initialize Electron binary before probe')
  const probeIndex = steps.findIndex((step) => step.name === 'Probe chat IPC business lifecycle')
  ;[steps[initIndex], steps[probeIndex]] = [steps[probeIndex], steps[initIndex]]
  assert.ok(checkWorkflow(reordered).some((issue) => issue.includes('chat_business_probe: Electron initialization must precede the probe')))

  const ignored = validWorkflow()
  ignored.jobs.chat_business_probe.steps.find((step) => step.name === 'Initialize Electron binary before probe')['continue-on-error'] = true
  assert.ok(checkWorkflow(ignored).some((issue) => issue.includes('chat_business_probe: Electron initialization failure must stop the probe')))

  const required = validWorkflow()
  required.jobs['ci-required'].needs.push('chat_business_probe', 'storage-perf')
  assert.ok(checkWorkflow(required).some((issue) => issue.includes('ci-required must not depend on observational job chat_business_probe')))
  assert.ok(checkWorkflow(required).some((issue) => issue.includes('ci-required must not depend on observational job storage-perf')))
})

test('tracks the storage performance observation lane and sanitized artifact contract', () => {
  assert.deepEqual(checkWorkflow(validWorkflow()), [])

  const jobLevelContinuation = validWorkflow()
  jobLevelContinuation.jobs['storage-perf']['continue-on-error'] = true
  assert.ok(checkWorkflow(jobLevelContinuation).some((issue) => issue.includes('storage-perf must not use job-level continue-on-error')))

  const budgetFailureBlocksJob = validWorkflow()
  const perfStep = budgetFailureBlocksJob.jobs['storage-perf'].steps.find((step) => step.run === 'npm run test:storage-perf -- --reporter=json --outputFile=.ci/storage-perf-report.json')
  delete perfStep['continue-on-error']
  assert.ok(checkWorkflow(budgetFailureBlocksJob).some((issue) => issue.includes('storage-perf must continue after a budget-only failure')))

  const changed = validWorkflow()
  const steps = changed.jobs['storage-perf'].steps
  const buildIndex = steps.findIndex((step) => step.run === 'npm run build:agent-provider-pi-ai')
  const build = steps.splice(buildIndex, 1)[0]
  steps.push(build)
  assert.ok(checkWorkflow(changed).some((issue) => issue.includes('storage-perf must build the provider before running its selected tests')))

  const missingSummary = validWorkflow()
  missingSummary.jobs['storage-perf'].steps.find((step) => step.name === 'Summarize selected storage performance results').if = 'success()'
  assert.ok(checkWorkflow(missingSummary).some((issue) => issue.includes('storage-perf must always create its sanitized summary')))
})
