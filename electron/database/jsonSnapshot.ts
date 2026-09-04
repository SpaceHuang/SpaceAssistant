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
    // 不可信 JSON → DbSnapshot 的唯一边界：在此完成完整归一（评审 C2）。
    // node:sqlite 拒绝 undefined 绑定且对多余命名参数键抛 Unknown named parameter，
    // 因此消息/搜索历史一律重建为仅含已知字段、可空列归一为 null 的对象，
    // 插入层不再各自维护字段清单。
    messages: Array.isArray(parsed.messages)
      ? (
          parsed.messages as Array<
            Partial<StoredMessage> & { session_id?: string } & Record<string, unknown>
          >
        )
          .map((m) => ({
            id: m.id ?? '',
            sessionId: m.sessionId ?? m.session_id ?? '',
            role: m.role ?? '',
            content: m.content ?? '',
            toolUse: m.toolUse ?? null,
            toolCalls: m.toolCalls ?? null,
            thinking: m.thinking ?? null,
            contentSegments: m.contentSegments ?? null,
            skillHints: m.skillHints ?? null,
            attachments: m.attachments ?? null,
            imagesDeliveredToApi: m.imagesDeliveredToApi ?? null,
            status: m.status ?? 'sent',
            schemaVersion: m.schemaVersion ?? 1,
            timestamp: m.timestamp ?? 0,
            sequence: m.sequence ?? 0
          }))
          .filter((m) => Boolean(m.id && m.sessionId))
      : [],
    configs: parsed.configs && typeof parsed.configs === 'object' ? (parsed.configs as DbSnapshot['configs']) : {},
    searchHistory: Array.isArray(parsed.searchHistory)
      ? (parsed.searchHistory as Array<Record<string, unknown>>).flatMap((h) => {
          // 剔除历史遗留多余字段（node:sqlite 对多余命名参数键抛 Unknown named parameter）并过滤无效项
          if (typeof h?.id !== 'string' || !h.id) return []
          if (typeof h.query !== 'string' || typeof h.timestamp !== 'number') return []
          return [{ id: h.id, query: h.query, timestamp: h.timestamp }]
        })
      : [],
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
