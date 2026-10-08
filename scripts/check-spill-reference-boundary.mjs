#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const canonicalTables = ['agent_history_events', 'session_transcript_entries']
const expected = new Map([
  ['electron/database/agentHistoryStorage.ts|agent_history_events|insert', 1],
  ['electron/database/sessionTranscript.ts|session_transcript_entries|insert', 2],
  ['electron/database/operations.ts|agent_history_events|delete', 1],
  ['electron/database/operations.ts|session_transcript_entries|delete', 1],
  // v54 AFTER UPDATE triggers maintain revision/generation for external canonical SQL writers.
  ['electron/database/migrations.ts|agent_history_events|update', 1],
  ['electron/database/migrations.ts|session_transcript_entries|update', 1],
  // v32 backfills ordering metadata only; it never changes payload_json.
  ['electron/database/schema.ts|agent_history_events|update', 1]
])
const protectedRoots = ['packages/agent-sdk', 'src/renderer', 'electron/sessionStorage/contracts.ts', 'electron/ipc']
const forbiddenContractPattern = /spill_reference_(?:index|backfill)|SpillReference(?:Index|Backfill|Descriptor)|canonical_change_generation|descriptor_path|maintenance_lease/i

function filesUnder(target) {
  if (!existsSync(target)) return []
  const info = statSync(target)
  if (info.isFile()) return [target]
  return readdirSync(target).flatMap((name) => filesUnder(path.join(target, name)))
}

export function inspectSpillReferenceBoundary(read = readFileSync) {
  const counts = new Map()
  const violations = []
  for (const file of filesUnder(path.join(root, 'electron'))) {
    if (!/\.(?:ts|tsx|mts|cts)$/.test(file) || /\.(?:test|spec)\./.test(file)) continue
    const relative = path.relative(root, file).replaceAll('\\', '/')
    const source = read(file, 'utf8')
    const sqlPattern = /\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+["`[]?(agent_history_events|session_transcript_entries)\b/gi
    for (const match of source.matchAll(sqlPattern)) {
      const verb = match[1].replace(/\s+/g, ' ').toLowerCase()
      const operation = verb.startsWith('insert') || verb.startsWith('replace') ? 'insert' : verb.startsWith('delete') ? 'delete' : 'update'
      const key = `${relative}|${match[2]}|${operation}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  for (const key of new Set([...expected.keys(), ...counts.keys()])) {
    const want = expected.get(key) ?? 0
    const got = counts.get(key) ?? 0
    if (want !== got) violations.push(`${key}: expected ${want} registered write(s), found ${got}`)
  }
  for (const protectedRoot of protectedRoots) {
    for (const file of filesUnder(path.join(root, protectedRoot))) {
      if (!/\.(?:ts|tsx|mts|cts)$/.test(file) || /\.(?:test|spec)\./.test(file)) continue
      const relative = path.relative(root, file).replaceAll('\\', '/')
      if (forbiddenContractPattern.test(read(file, 'utf8'))) violations.push(`${relative}: Spill index implementation detail leaked into a protected contract`)
    }
  }
  return { counts, violations }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { counts, violations } = inspectSpillReferenceBoundary()
  if (violations.length) {
    console.error('[check:spill-reference-boundary] failed:')
    for (const violation of violations) console.error(`  - ${violation}`)
    process.exitCode = 1
  } else {
    console.log(`[check:spill-reference-boundary] OK: ${counts.size} registered canonical SQL write signatures; no contract leakage`)
  }
}
