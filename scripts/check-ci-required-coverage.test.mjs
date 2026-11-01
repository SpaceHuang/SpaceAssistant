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
