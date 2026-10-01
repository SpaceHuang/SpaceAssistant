#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = path.join(root, 'node_modules/@earendil-works/pi-ai')
const distRoot = path.join(packageRoot, 'dist')
const appPackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const expectedFiles = JSON.parse(readFileSync(path.join(root, 'scripts/pi-ai-anthropic-runtime-files.json'), 'utf8'))
const entries = ['api/anthropic-messages.js', 'utils/transcript.js']
const reachable = new Set()
const errors = []

function resolveRelativeImport(from, specifier) {
  const base = path.resolve(path.dirname(from), specifier)
  const candidates = path.extname(base) ? [base] : [`${base}.js`, `${base}.json`, path.join(base, 'index.js')]
  return candidates.find((candidate) => candidate.startsWith(`${distRoot}${path.sep}`) && existsSync(candidate) && statSync(candidate).isFile())
}
function visit(file) {
  if (reachable.has(file)) return
  reachable.add(file)
  const source = readFileSync(file, 'utf8')
  const specifiers = [...source.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
  for (const specifier of specifiers) {
    if (!specifier.startsWith('.')) continue
    const dependency = resolveRelativeImport(file, specifier)
    if (!dependency) errors.push(`${path.relative(distRoot, file)} -> ${specifier} (unresolved local import)`)
    else visit(dependency)
  }
}
for (const entry of entries) {
  const absolute = path.join(distRoot, entry)
  if (!existsSync(absolute)) errors.push(`missing pi-ai entry: ${entry}`)
  else visit(absolute)
}
const actualFiles = [...reachable].map((file) => path.relative(distRoot, file).split(path.sep).join('/')).sort()
const sortedExpected = [...expectedFiles].sort()
if (JSON.stringify(actualFiles) !== JSON.stringify(sortedExpected)) {
  errors.push(`runtime closure manifest drifted; actual=${JSON.stringify(actualFiles)}`)
}
const buildFiles = appPackage.build?.files ?? []
const piAiPrefix = 'node_modules/@earendil-works/pi-ai/'
if (!buildFiles.includes('!node_modules/@earendil-works/pi-ai/dist/**/*')) {
  errors.push('electron-builder files must exclude all pi-ai dist files before the runtime allowlist')
}
for (const relative of ['package.json', ...expectedFiles.map((file) => `dist/${file}`)]) {
  if (!buildFiles.includes(`${piAiPrefix}${relative}`)) errors.push(`electron-builder files must include ${piAiPrefix}${relative}`)
}
if (errors.length) {
  console.error('[check:pi-ai-runtime-closure] FAIL')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}
const bytes = actualFiles.reduce((total, file) => total + statSync(path.join(distRoot, file)).size, 0)
console.log(`[check:pi-ai-runtime-closure] OK: ${actualFiles.length} Anthropic runtime files (${bytes} bytes), no unresolved local imports`)
