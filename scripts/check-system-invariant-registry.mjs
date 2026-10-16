import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const registryPath = path.join(root, 'src/shared/security/systemInvariantRegistry.ts')
const source = fs.readFileSync(registryPath, 'utf8')
const injectedSource = process.env.SYSTEM_INVARIANT_REGISTRY_SOURCE
const inputSource = injectedSource ? Buffer.from(injectedSource, 'base64').toString('utf8') : source
const block = inputSource.match(/SYSTEM_INVARIANT_REGISTRY[^=]*= Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1]
if (!block) throw new Error('SYSTEM_INVARIANT_REGISTRY literal not found')

const entries = [...block.matchAll(/\{([\s\S]*?)\n  \}/g)].map(([, body]) => body)
if (entries.length === 0) throw new Error('SYSTEM_INVARIANT_REGISTRY must contain audited invariants')

const ids = []
const referencedTests = []
const stringFields = ['id', 'owner', 'stage', 'category', 'rationale', 'effect', 'scope', 'audit', 'overrideability']
for (const body of entries) {
  for (const field of stringFields) {
    const value = body.match(new RegExp(`\\b${field}:\\s*['\"]([^'\"]*)['\"]`))?.[1]
    if (!value?.trim()) throw new Error(`registry entry missing ${field}`)
  }
  if (!/\btests:\s*\[[^\]]+\]/.test(body)) throw new Error('registry entry missing tests')
  const id = body.match(/\bid:\s*['"]([^'"]+)['"]/)?.[1]
  if (!id || !/^SYS-[A-Z0-9]+-[0-9]{3}$/.test(id)) throw new Error(`invalid registry ID: ${id ?? '<missing>'}`)
  if (ids.includes(id)) throw new Error(`duplicate registry ID: ${id}`)
  ids.push(id)
  for (const [, testPath] of body.matchAll(/['"]((?:[\w.-]+\/)+[\w.-]+\.test\.[jt]sx?)['"]/g)) referencedTests.push(testPath)
  if (body.includes("category: 'decision-floor'") && !/nonConfigurableReason:\s*['"][^'"]{20,}['"]/.test(body)) throw new Error(`${id} decision-floor requires nonConfigurableReason`)
}

if (!/validateSystemInvariantRegistry\(SYSTEM_INVARIANT_REGISTRY\)/.test(fs.readFileSync(path.join(root, 'src/shared/security/systemInvariantRegistry.test.ts'), 'utf8'))) {
  throw new Error('registry validation test must validate the complete source registry')
}
for (const testPath of referencedTests) {
  if (!fs.existsSync(path.join(root, testPath))) throw new Error(`registry test reference does not exist: ${testPath}`)
}

const runtimeSources = [
  'electron/confirmation/toolCallGate.ts',
  'electron/confirmation/policyRulesRuntime.ts',
  'src/shared/policy/policyEngine.ts',
  'electron/tools/plannedToolRegistry.ts'
]
for (const relativePath of runtimeSources) {
  if (fs.readFileSync(path.join(root, relativePath), 'utf8').includes('SYSTEM_INVARIANT_REGISTRY')) {
    throw new Error(`runtime policy/execution code must not load the source-only registry: ${relativePath}`)
  }
}

console.log(`[system-invariant-registry] ${ids.length} registrations; ${referencedTests.length} test references verified`)
