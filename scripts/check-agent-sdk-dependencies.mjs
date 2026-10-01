#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sdkDir = path.join(root, 'packages', 'agent-sdk', 'src')
const sharedDir = path.join(root, 'src', 'shared')

function filesUnder(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name)
    return statSync(file).isDirectory() ? filesUnder(file) : file.endsWith('.ts') || file.endsWith('.tsx') ? [file] : []
  })
}

function importsFrom(source) {
  const re = /(?:import\s+[^'"()]*?from\s*|import\s*|export\s+[^'"()]*?from\s*|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g
  return [...source.matchAll(re)].map((match) => match[1])
}

const failures = []
for (const file of filesUnder(sharedDir)) {
  const rel = path.relative(root, file)
  for (const spec of importsFrom(readFileSync(file, 'utf8'))) {
    if (spec.includes('packages/agent-sdk') || spec.includes('packages/agent-sdk') || spec === '@spaceassistant/agent-sdk' || spec === '@spaceassistant/agent-sdk') {
      failures.push(`${rel}: src/shared 不得依赖 Agent SDK (${spec})`)
    }
  }
}

if (failures.length) {
  console.error('[check:agent-sdk-dependencies] 依赖方向违规:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('[check:agent-sdk-dependencies] OK: src/shared 不依赖 Agent SDK')
