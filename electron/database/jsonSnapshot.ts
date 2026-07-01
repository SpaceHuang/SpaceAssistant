import fs from 'fs'
import type { SessionUsage } from '../../src/shared/sessionUsage'
import type { DbSnapshot, StoredMessage } from './types'

export function emptySnapshot(): DbSnapshot {
  return {
    sessions: [],
    messages: [],
    configs: {},
    searchHistory: [],
    sessionUsages: {}
  }
}

/** Load legacy JSON snapshot; throws on parse failure (migration path). */
export function loadSnapshotFromJson(filePath: string): DbSnapshot {
  const raw = fs.readFileSync(filePath, 'utf8')
  let parsed: Partial<DbSnapshot>
  try {
    parsed = JSON.parse(raw) as Partial<DbSnapshot>
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to parse JSON database at ${filePath}: ${msg}`)
  }
  return {
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    messages: Array.isArray(parsed.messages)
      ? (parsed.messages as StoredMessage[]).map((m) => ({
          ...m,
          toolCalls: m.toolCalls ?? null,
          skillHints: m.skillHints ?? null
        }))
      : [],
    configs: parsed.configs && typeof parsed.configs === 'object' ? (parsed.configs as DbSnapshot['configs']) : {},
    searchHistory: Array.isArray(parsed.searchHistory) ? parsed.searchHistory : [],
    sessionUsages:
      parsed.sessionUsages && typeof parsed.sessionUsages === 'object'
        ? (parsed.sessionUsages as Record<string, SessionUsage>)
        : {}
  }
}

export function resolveJsonPathForDb(dbPath: string): string {
  if (dbPath.endsWith('.json')) return dbPath
  return dbPath.replace(/\.db$/i, '.json')
}

export function resolveDbPath(inputPath: string): string {
  if (inputPath === ':memory:') return inputPath
  if (inputPath.endsWith('.db')) return inputPath
  if (inputPath.endsWith('.json')) return inputPath.replace(/\.json$/i, '.db')
  return `${inputPath}.db`
}
