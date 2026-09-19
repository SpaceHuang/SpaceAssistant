import type { AppDatabase } from '../database'
import {
  deleteConfigValue,
  getConfigValue,
  getDbConnection,
  setConfigValue
} from '../database'
import { runInTransaction } from '../database/transaction'
import {
  MCP_MAX_SERVERS,
  McpServerWriteInputSchema,
  parseMcpServerProfiles,
  parseMcpToolCache,
  type McpServerProfile,
  type McpServerWriteInput,
  type McpToolCacheEntry
} from '../../src/shared/mcpTypes'
import { isSecretStorageAvailable, encryptSecret } from '../secureApiKey'
import {
  assertValidSecretRef,
  deleteSecretsForServerRaw,
  readSecretMapRaw,
  secretMapKey,
  withMcpSecretWriteLock,
  writeSecretMapRaw
} from './mcpSecretStore'

/**
 * MCP 配置存储：`config.mcpServers`（Profile 列表）、`config.mcpToolCache.<serverId>`（工具缓存）、
 * `config.mcpDiagnostics.<serverId>`（诊断）。
 * 保存/删除通过 DB 事务协调 Secret 引用与元数据；encryptSecret 抛错时回滚，不留半成品。
 */

export const MCP_CONFIG_KEYS = {
  profiles: 'config.mcpServers',
  toolCache: (serverId: string) => `config.mcpToolCache.${serverId}`,
  diagnostics: (serverId: string) => `config.mcpDiagnostics.${serverId}`
} as const

export function listProfiles(db: AppDatabase): McpServerProfile[] {
  return parseMcpServerProfiles(getConfigValue(db, MCP_CONFIG_KEYS.profiles))
}

type SecretChange =
  | { serverId: string; kind: string; enc: string }
  | { serverId: string; kind: string; clear: true }

function buildSecretChanges(input: McpServerWriteInput): SecretChange[] {
  const changes: SecretChange[] = []
  if (input.auth.accessToken?.trim()) {
    if (!isSecretStorageAvailable()) {
      throw new Error('系统不支持安全存储（safeStorage），无法保存 MCP Secret')
    }
    changes.push({ serverId: input.id, kind: 'access-token', enc: encryptSecret(input.auth.accessToken.trim()) })
  }
  if (input.auth.headerValue?.trim()) {
    if (!isSecretStorageAvailable()) {
      throw new Error('系统不支持安全存储（safeStorage），无法保存 MCP Secret')
    }
    changes.push({ serverId: input.id, kind: 'auth-header', enc: encryptSecret(input.auth.headerValue.trim()) })
  }
  for (const env of input.stdio?.env ?? []) {
    if (env.value !== undefined && env.value !== '') {
      if (!isSecretStorageAvailable()) {
        throw new Error('系统不支持安全存储（safeStorage），无法保存 MCP Secret')
      }
      changes.push({ serverId: input.id, kind: `env:${env.key}`, enc: encryptSecret(env.value) })
    } else if (env.clear) {
      changes.push({ serverId: input.id, kind: `env:${env.key}`, clear: true })
    }
  }
  for (const kind of input.clearSecretKinds ?? []) {
    assertValidSecretRef(input.id, kind)
    changes.push({ serverId: input.id, kind, clear: true })
  }
  return changes
}

function modeSecretKinds(mode: McpServerWriteInput['auth']['mode']): string[] {
  switch (mode) {
    case 'bearer-token':
      return ['access-token']
    case 'custom-header':
      return ['auth-header']
    case 'oauth':
      return ['access-token', 'refresh-token']
    default:
      return []
  }
}

/**
 * 保存整个 Profile 列表（唯一的 MCP Profile/Secret 持久化通道）。
 * 一次性 Secret 仅在请求体出现一次：加密后立即写入 Secret map，不进入 Profile JSON。
 * 「读 previous + 合并 + 写」整体在写锁临界区内（v2 评审 S2'）。
 */
export async function saveProfiles(
  db: AppDatabase,
  inputs: McpServerWriteInput[]
): Promise<McpServerProfile[]> {
  return withMcpSecretWriteLock(() => saveProfilesLocked(db, inputs))
}

/**
 * 追加单个服务（v2 评审 S2'）：addMcpServer 等增量写入方必须走本函数——
 * 「读既有 + 合并 + 写」整体在写锁临界区内，两次并发 append 不会互相覆盖丢服务。
 * 与既有服务重名时抛错（事务回滚，无副作用）。
 */
/**
 * 既有 profile → write input：appendServer 的合并输入。
 * secret 不回填（保留在 secret map 中，saveProfiles 对未出现的 kind 不做 clear）。
 */
function existingProfilesAsWriteInputs(profiles: McpServerProfile[]): McpServerWriteInput[] {
  return profiles.map((p) => ({
    id: p.id,
    name: p.name,
    enabled: p.enabled,
    transport: p.transport,
    timeoutSec: p.timeoutSec,
    auth: {
      mode: p.auth.mode,
      ...(p.auth.headerName ? { headerName: p.auth.headerName } : {}),
      ...(p.auth.valuePrefix ? { valuePrefix: p.auth.valuePrefix } : {}),
      ...(p.auth.oauthClientId ? { oauthClientId: p.auth.oauthClientId } : {}),
      ...(p.auth.oauthScopes?.length ? { oauthScopes: p.auth.oauthScopes } : {}),
      ...(p.auth.accessTokenExpiresAt ? { accessTokenExpiresAt: p.auth.accessTokenExpiresAt } : {})
    },
    ...(p.stdio
      ? {
          stdio: {
            command: p.stdio.command,
            args: p.stdio.args,
            ...(p.stdio.cwd ? { cwd: p.stdio.cwd } : {}),
            env: p.stdio.env.map((e) => ({ key: e.key, valuePresent: e.valuePresent })),
            ...(p.stdio.commandTrustedAt ? { commandTrustedAt: p.stdio.commandTrustedAt } : {})
          }
        }
      : {}),
    ...(p.http ? { http: { endpoint: p.http.endpoint } } : {}),
    enabledToolNames: p.enabledToolNames,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  }))
}

export async function appendServer(
  db: AppDatabase,
  input: McpServerWriteInput
): Promise<McpServerProfile[]> {
  return withMcpSecretWriteLock(() => {
    const existing = listProfiles(db)
    return saveProfilesLocked(db, [...existingProfilesAsWriteInputs(existing), input])
  })
}

function saveProfilesLocked(
  db: AppDatabase,
  inputs: McpServerWriteInput[]
): McpServerProfile[] {
  const parsedInputs = inputs.map((i) => McpServerWriteInputSchema.parse(i))

  if (parsedInputs.length > MCP_MAX_SERVERS) {
    throw new Error(`最多配置 ${MCP_MAX_SERVERS} 个 MCP 服务`)
  }
  const nameSeen = new Set<string>()
  for (const input of parsedInputs) {
    const lower = input.name.trim().toLowerCase()
    if (nameSeen.has(lower)) {
      throw new Error(`MCP 服务名称「${input.name}」重复`)
    }
    nameSeen.add(lower)
  }

  // 先完成全部加密（可能抛错 → 不写任何内容），再进事务写库。
  const secretChanges: SecretChange[] = []
  for (const input of parsedInputs) {
    secretChanges.push(...buildSecretChanges(input))
  }

  const previous = listProfiles(db)
  const previousById = new Map(previous.map((p) => [p.id, p]))
  const nextIds = new Set(parsedInputs.map((i) => i.id))
  const now = new Date().toISOString()

  const nextProfiles: McpServerProfile[] = parsedInputs.map((input) => {
    const prev = previousById.get(input.id)
    const env = (input.stdio?.env ?? []).map((e) => ({ key: e.key, valuePresent: e.valuePresent }))
    return {
      id: input.id,
      name: input.name.trim(),
      enabled: input.enabled,
      transport: input.transport,
      timeoutSec: input.timeoutSec,
      auth: {
        mode: input.auth.mode,
        secretPresent: false,
        headerName: input.auth.headerName,
        valuePrefix: input.auth.valuePrefix,
        oauthClientId: input.auth.oauthClientId,
        oauthScopes: input.auth.oauthScopes,
        accessTokenExpiresAt: input.auth.accessTokenExpiresAt
      },
      ...(input.stdio
        ? {
            stdio: {
              command: input.stdio.command,
              args: input.stdio.args,
              ...(input.stdio.cwd ? { cwd: input.stdio.cwd } : {}),
              env,
              ...(input.stdio.commandTrustedAt ? { commandTrustedAt: input.stdio.commandTrustedAt } : {})
            }
          }
        : {}),
      ...(input.http ? { http: { endpoint: input.http.endpoint } } : {}),
      enabledToolNames: input.enabledToolNames,
      ...(prev?.discoveredAt ? { discoveredAt: prev.discoveredAt } : {}),
      ...(prev?.discoveredProtocolVersion ? { discoveredProtocolVersion: prev.discoveredProtocolVersion } : {}),
      status: prev?.status ?? 'untested',
      ...(prev?.lastError ? { lastError: prev.lastError } : {}),
      createdAt: prev?.createdAt ?? input.createdAt ?? now,
      updatedAt: now
    }
  })

  return runInTransaction(getDbConnection(db), () => {
    const map = readSecretMapRaw(db)
    for (const change of secretChanges) {
      const key = secretMapKey(change.serverId, change.kind)
      if ('clear' in change) {
        delete map[key]
      } else {
        map[key] = change.enc
      }
    }
    for (const id of previous.map((p) => p.id)) {
      if (!nextIds.has(id)) {
        const prefix = `${id}:`
        for (const key of Object.keys(map)) {
          if (key.startsWith(prefix)) delete map[key]
        }
      }
    }
    writeSecretMapRaw(db, map)

    for (const profile of nextProfiles) {
      const kinds = modeSecretKinds(profile.auth.mode)
      profile.auth.secretPresent = kinds.some((k) => Boolean(map[secretMapKey(profile.id, k)]))
      if (profile.stdio) {
        profile.stdio.env = profile.stdio.env.map((e) => ({
          key: e.key,
          valuePresent: Boolean(map[secretMapKey(profile.id, `env:${e.key}`)])
        }))
      }
    }

    setConfigValue(db, MCP_CONFIG_KEYS.profiles, JSON.stringify(nextProfiles))
    for (const id of previous.map((p) => p.id)) {
      if (!nextIds.has(id)) {
        deleteConfigValue(db, MCP_CONFIG_KEYS.toolCache(id))
        deleteConfigValue(db, MCP_CONFIG_KEYS.diagnostics(id))
      }
    }
    return nextProfiles
  })
}

/** 删除服务：连带清 Secret、工具缓存与诊断。 */
export async function deleteServer(db: AppDatabase, serverId: string): Promise<void> {
  return withMcpSecretWriteLock(() => {
    runInTransaction(getDbConnection(db), () => {
      const profiles = listProfiles(db).filter((p) => p.id !== serverId)
      setConfigValue(db, MCP_CONFIG_KEYS.profiles, JSON.stringify(profiles))
      deleteSecretsForServerRaw(db, serverId)
      deleteConfigValue(db, MCP_CONFIG_KEYS.toolCache(serverId))
      deleteConfigValue(db, MCP_CONFIG_KEYS.diagnostics(serverId))
    })
  })
}

export function getToolCache(db: AppDatabase, serverId: string): McpToolCacheEntry | null {
  return parseMcpToolCache(getConfigValue(db, MCP_CONFIG_KEYS.toolCache(serverId)))
}

export function saveToolCache(db: AppDatabase, serverId: string, entry: McpToolCacheEntry): void {
  setConfigValue(db, MCP_CONFIG_KEYS.toolCache(serverId), JSON.stringify(entry))
}

export function clearToolCache(db: AppDatabase, serverId: string): void {
  deleteConfigValue(db, MCP_CONFIG_KEYS.toolCache(serverId))
}

/** 状态类字段补丁（连接测试/刷新工具后更新），不触碰 Secret。 */
export async function updateServerStatus(
  db: AppDatabase,
  serverId: string,
  patch: {
    status?: McpServerProfile['status']
    discoveredProtocolVersion?: string
    discoveredAt?: string
    lastError?: McpServerProfile['lastError']
    clearLastError?: boolean
    enabled?: boolean
    auth?: Partial<McpServerProfile['auth']>
  }
): Promise<void> {
  // 中6（评审）：整表读改写必须在 secret 写锁内，避免与 appendServer 交错造成
  // 「锁外读到旧表 → 整表回写」丢失并发新增的服务（secret 成孤儿）。
  return withMcpSecretWriteLock(() => {
  const profiles = listProfiles(db)
  const index = profiles.findIndex((p) => p.id === serverId)
  if (index < 0) return
  const profile = profiles[index]!
  const next: McpServerProfile = {
    ...profile,
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.discoveredProtocolVersion !== undefined
      ? { discoveredProtocolVersion: patch.discoveredProtocolVersion }
      : {}),
    ...(patch.discoveredAt ? { discoveredAt: patch.discoveredAt } : {}),
    ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
    ...(patch.clearLastError ? { lastError: undefined } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.auth ? { auth: { ...profile.auth, ...patch.auth } } : {}),
    updatedAt: new Date().toISOString()
  }
  profiles[index] = next
  setConfigValue(db, MCP_CONFIG_KEYS.profiles, JSON.stringify(profiles))
  })
}

/** 依据当前 Secret map 重算所有 Profile 的 secretPresent / env valuePresent。 */
export function refreshProfilesSecretFlags(db: AppDatabase): McpServerProfile[] {
  const map = readSecretMapRaw(db)
  const profiles = listProfiles(db)
  for (const profile of profiles) {
    const kinds = modeSecretKinds(profile.auth.mode)
    profile.auth.secretPresent = kinds.some((k) => Boolean(map[secretMapKey(profile.id, k)]))
    if (profile.stdio) {
      profile.stdio.env = profile.stdio.env.map((e) => ({
        key: e.key,
        valuePresent: Boolean(map[secretMapKey(profile.id, `env:${e.key}`)])
      }))
    }
  }
  return profiles
}
