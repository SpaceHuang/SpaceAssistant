import { randomUUID } from 'crypto'
import type { AppDatabase } from '../database'
import { deleteConfigValue, getConfigValue, setConfigValue } from '../database'
import { sanitizeForLog } from '../logSanitize'
import {
  MCP_DIAGNOSTICS_MAX_PER_SERVER,
  MCP_DIAGNOSTICS_RETENTION_MS,
  type McpDiagnosticEntry
} from '../../src/shared/mcpTypes'
import { getSecret, listSecretKindsForServer } from './mcpSecretStore'

/**
 * MCP 错误诊断环形缓冲：每服务最多 20 条、保留 30 天。
 * 写入前脱敏：基底复用 sanitizeForLog，追加 MCP 专属规则——
 * 掩码「当次涉及 serverId」已知 Secret 值的字面出现、endpoint userinfo。
 * 不建立独立脱敏体系，不解密其他服务的 Secret。
 */

export function mcpDiagnosticsKey(serverId: string): string {
  return `config.mcpDiagnostics.${serverId}`
}

function readEntries(db: AppDatabase, serverId: string, now: number): McpDiagnosticEntry[] {
  const raw = getConfigValue(db, mcpDiagnosticsKey(serverId))
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: McpDiagnosticEntry[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      if (typeof o.id !== 'string' || typeof o.code !== 'string' || typeof o.message !== 'string') continue
      const occurredAt = typeof o.occurredAt === 'string' ? o.occurredAt : ''
      const ts = Date.parse(occurredAt)
      if (Number.isNaN(ts) || now - ts > MCP_DIAGNOSTICS_RETENTION_MS) continue
      out.push({ id: o.id, code: o.code, message: o.message, occurredAt })
    }
    return out
  } catch {
    return []
  }
}

const ENDPOINT_USERINFO_RE = /(\/\/)[^/@\s]+@/g

async function maskKnownSecrets(db: AppDatabase, serverId: string, message: string): Promise<string> {
  let out = message
  const kinds = listSecretKindsForServer(db, serverId)
  for (const kind of kinds) {
    const plain = await getSecret(db, serverId, kind)
    if (plain && plain.length >= 4 && out.includes(plain)) {
      out = out.split(plain).join('[REDACTED]')
    }
  }
  return out
}

export async function appendDiagnostic(
  db: AppDatabase,
  serverId: string,
  entry: { code: string; message: string },
  now = Date.now()
): Promise<void> {
  const base = sanitizeForLog(entry.message)
  const baseText = typeof base === 'string' ? base : String(base)
  const secretMasked = await maskKnownSecrets(db, serverId, baseText)
  const masked = secretMasked.replace(ENDPOINT_USERINFO_RE, '$1[REDACTED]@')

  const entries = readEntries(db, serverId, now)
  entries.push({
    id: randomUUID(),
    code: entry.code.slice(0, 64),
    message: masked.slice(0, 2000),
    occurredAt: new Date(now).toISOString()
  })
  if (entries.length > MCP_DIAGNOSTICS_MAX_PER_SERVER) {
    entries.splice(0, entries.length - MCP_DIAGNOSTICS_MAX_PER_SERVER)
  }
  setConfigValue(db, mcpDiagnosticsKey(serverId), JSON.stringify(entries))
}

export function getDiagnostics(db: AppDatabase, serverId: string): McpDiagnosticEntry[] {
  return readEntries(db, serverId, Date.now())
}

export function clearDiagnostics(db: AppDatabase, serverId: string): void {
  deleteConfigValue(db, mcpDiagnosticsKey(serverId))
}
