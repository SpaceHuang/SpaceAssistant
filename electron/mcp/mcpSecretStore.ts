import type { AppDatabase } from '../database'
import { getConfigValue, setConfigValue } from '../database'
import { decryptSecret, encryptSecret, isSecretStorageAvailable } from '../secureApiKey'

/**
 * MCP Secret Store：以 `secrets.mcp.credentials` 单键 JSON（`Record<'<serverId>:<kind>', encBase64>`）
 * 复用 safeStorage 加密读写，模式对齐 `secrets.llmServiceKeys`。
 *
 * 写互斥（评审 A1）：所有写操作必须经单一 Promise 链串行化「读→改→写」临界区，
 * 避免与 OAuth 后台刷新等第二写入源交错时丢更新。
 */

export const MCP_SECRETS_CONFIG_KEY = 'secrets.mcp.credentials'

const SECRET_KIND_RE = /^(access-token|refresh-token|auth-header|env:[A-Za-z_][A-Za-z0-9_]*)$/

export type McpSecretMap = Record<string, string>

export function secretMapKey(serverId: string, kind: string): string {
  return `${serverId}:${kind}`
}

export function assertValidSecretRef(serverId: string, kind: string): void {
  if (!serverId || !serverId.trim()) {
    throw new Error('serverId 不能为空')
  }
  if (!SECRET_KIND_RE.test(kind)) {
    throw new Error(`非法 Secret kind: ${kind}`)
  }
}

export function readSecretMapRaw(db: AppDatabase): McpSecretMap {
  const raw = getConfigValue(db, MCP_SECRETS_CONFIG_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: McpSecretMap = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.trim()) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** 仅在 `withMcpSecretWriteLock` 临界区内调用，否则会绕过写互斥。 */
export function writeSecretMapRaw(db: AppDatabase, map: McpSecretMap): void {
  setConfigValue(db, MCP_SECRETS_CONFIG_KEY, JSON.stringify(map))
}

let writeChain: Promise<void> = Promise.resolve()

/** 主进程内单一互斥队列：串行化所有 Secret「读→改→写」临界区。 */
export function withMcpSecretWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const result = writeChain.then(fn)
  writeChain = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

export async function setSecret(db: AppDatabase, serverId: string, kind: string, plain: string): Promise<void> {
  return withMcpSecretWriteLock(() => {
    assertValidSecretRef(serverId, kind)
    if (!isSecretStorageAvailable()) {
      throw new Error('系统不支持安全存储（safeStorage），无法保存 MCP Secret')
    }
    const enc = encryptSecret(plain)
    const map = readSecretMapRaw(db)
    map[secretMapKey(serverId, kind)] = enc
    writeSecretMapRaw(db, map)
  })
}

export async function getSecret(db: AppDatabase, serverId: string, kind: string): Promise<string | null> {
  assertValidSecretRef(serverId, kind)
  const map = readSecretMapRaw(db)
  const enc = map[secretMapKey(serverId, kind)]
  if (!enc) return null
  if (!isSecretStorageAvailable()) return null
  try {
    return decryptSecret(enc)
  } catch {
    return null
  }
}

export function hasSecret(db: AppDatabase, serverId: string, kind: string): boolean {
  try {
    assertValidSecretRef(serverId, kind)
  } catch {
    return false
  }
  return Boolean(readSecretMapRaw(db)[secretMapKey(serverId, kind)])
}

export async function clearSecret(db: AppDatabase, serverId: string, kind: string): Promise<void> {
  return withMcpSecretWriteLock(() => {
    assertValidSecretRef(serverId, kind)
    const map = readSecretMapRaw(db)
    const key = secretMapKey(serverId, kind)
    if (key in map) {
      delete map[key]
      writeSecretMapRaw(db, map)
    }
  })
}

export async function deleteSecretsForServer(db: AppDatabase, serverId: string): Promise<void> {
  if (!serverId || !serverId.trim()) return
  return withMcpSecretWriteLock(() => {
    deleteSecretsForServerRaw(db, serverId)
  })
}

/** 仅在 `withMcpSecretWriteLock` 临界区内调用（供事务组合使用）。 */
export function deleteSecretsForServerRaw(db: AppDatabase, serverId: string): void {
  const map = readSecretMapRaw(db)
  const prefix = `${serverId}:`
  let changed = false
  for (const key of Object.keys(map)) {
    if (key.startsWith(prefix)) {
      delete map[key]
      changed = true
    }
  }
  if (changed) writeSecretMapRaw(db, map)
}

/** 供设置页/诊断展示：返回某服务已配置的 Secret kind 列表（不含明文）。 */
export function listSecretKindsForServer(db: AppDatabase, serverId: string): string[] {
  if (!serverId || !serverId.trim()) return []
  const map = readSecretMapRaw(db)
  const prefix = `${serverId}:`
  return Object.keys(map)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
}
