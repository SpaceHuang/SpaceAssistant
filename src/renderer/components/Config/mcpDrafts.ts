import type {
  McpAuthMode,
  McpServerProfile,
  McpServerWriteInput,
  McpToolConfirmPolicy,
  McpTransportType
} from '../../../shared/mcpTypes'

/**
 * MCP 服务草稿的纯函数：初始化、转换为一次性写入输入、脏检测。
 * Secret 值只存在于草稿（渲染进程内存），仅在保存/测试时随请求体交给主进程。
 */

export type McpEnvDraft = {
  key: string
  value: string
  valuePresent: boolean
  /** 显式清除该环境变量 Secret。 */
  clear?: boolean
}

export type McpServerDraft = {
  id: string
  name: string
  enabled: boolean
  transport: McpTransportType
  timeoutSec: number
  auth: {
    mode: McpAuthMode
    headerName?: string
    valuePrefix?: string
    accessToken?: string
    headerValue?: string
    oauthClientId?: string
    oauthScopes?: string[]
  }
  stdio?: {
    command: string
    args: string[]
    cwd?: string
    env: McpEnvDraft[]
    commandTrustedAt?: string
  }
  http?: { endpoint: string }
  enabledToolNames: string[]
  toolConfirmPolicy: McpToolConfirmPolicy
  createdAt?: string
  updatedAt?: string
  clearSecretKinds?: string[]
}

function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    try {
      return crypto.randomUUID()
    } catch {
      /* fall through */
    }
  }
  return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function newMcpServerDraft(): McpServerDraft {
  return {
    id: createId(),
    name: '',
    enabled: false,
    transport: 'stdio',
    timeoutSec: 60,
    auth: { mode: 'none' },
    stdio: { command: '', args: [], env: [] },
    enabledToolNames: [],
    toolConfirmPolicy: 'always'
  }
}

export function initMcpServerDraft(profile: McpServerProfile): McpServerDraft {
  return {
    id: profile.id,
    name: profile.name,
    enabled: profile.enabled,
    transport: profile.transport,
    timeoutSec: profile.timeoutSec,
    auth: {
      mode: profile.auth.mode,
      headerName: profile.auth.headerName,
      valuePrefix: profile.auth.valuePrefix,
      oauthClientId: profile.auth.oauthClientId,
      oauthScopes: profile.auth.oauthScopes
    },
    ...(profile.stdio
      ? {
          stdio: {
            command: profile.stdio.command,
            args: profile.stdio.args,
            ...(profile.stdio.cwd ? { cwd: profile.stdio.cwd } : {}),
            env: profile.stdio.env.map((e) => ({
              key: e.key,
              value: '',
              valuePresent: e.valuePresent
            })),
            ...(profile.stdio.commandTrustedAt ? { commandTrustedAt: profile.stdio.commandTrustedAt } : {})
          }
        }
      : {}),
    ...(profile.http ? { http: { endpoint: profile.http.endpoint } } : {}),
    enabledToolNames: profile.enabledToolNames,
    toolConfirmPolicy: profile.toolConfirmPolicy,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  }
}

export function draftToWriteInput(draft: McpServerDraft): McpServerWriteInput {
  const auth: McpServerWriteInput['auth'] = {
    mode: draft.auth.mode,
    ...(draft.auth.headerName ? { headerName: draft.auth.headerName } : {}),
    ...(draft.auth.valuePrefix ? { valuePrefix: draft.auth.valuePrefix } : {}),
    ...(draft.auth.oauthClientId ? { oauthClientId: draft.auth.oauthClientId } : {}),
    ...(draft.auth.oauthScopes?.length ? { oauthScopes: draft.auth.oauthScopes } : {}),
    ...(draft.auth.accessToken ? { accessToken: draft.auth.accessToken } : {}),
    ...(draft.auth.headerValue ? { headerValue: draft.auth.headerValue } : {})
  }
  const stdio = draft.transport === 'stdio' && draft.stdio
    ? {
        command: draft.stdio.command,
        args: draft.stdio.args,
        ...(draft.stdio.cwd ? { cwd: draft.stdio.cwd } : {}),
        env: draft.stdio.env.map((e) => ({
          key: e.key,
          valuePresent: e.valuePresent,
          ...(e.clear ? { clear: true } : {}),
          ...(e.value ? { value: e.value } : {})
        })),
        ...(draft.stdio.commandTrustedAt ? { commandTrustedAt: draft.stdio.commandTrustedAt } : {})
      }
    : undefined
  const http = draft.transport === 'streamable-http' && draft.http
    ? { endpoint: draft.http.endpoint }
    : undefined
  return {
    id: draft.id,
    name: draft.name,
    enabled: draft.enabled,
    transport: draft.transport,
    timeoutSec: draft.timeoutSec,
    auth,
    ...(stdio ? { stdio } : {}),
    ...(http ? { http } : {}),
    enabledToolNames: draft.enabledToolNames,
    toolConfirmPolicy: draft.toolConfirmPolicy,
    ...(draft.createdAt ? { createdAt: draft.createdAt } : {}),
    ...(draft.updatedAt ? { updatedAt: draft.updatedAt } : {}),
    ...(draft.clearSecretKinds?.length ? { clearSecretKinds: draft.clearSecretKinds } : {})
  }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 与已保存 Profile 对比，判断草稿是否有未保存修改。 */
export function isMcpDraftDirty(
  profile: McpServerProfile | undefined,
  draft: McpServerDraft
): boolean {
  if (!profile) return true
  return (
    profile.name !== draft.name.trim() ||
    profile.enabled !== draft.enabled ||
    profile.transport !== draft.transport ||
    profile.timeoutSec !== draft.timeoutSec ||
    profile.auth.mode !== draft.auth.mode ||
    (profile.auth.headerName ?? '') !== (draft.auth.headerName ?? '') ||
    (profile.auth.valuePrefix ?? '') !== (draft.auth.valuePrefix ?? '') ||
    (profile.auth.oauthClientId ?? '') !== (draft.auth.oauthClientId ?? '') ||
    Boolean(draft.auth.accessToken?.trim()) ||
    Boolean(draft.auth.headerValue?.trim()) ||
    (profile.stdio?.command ?? '') !== (draft.stdio?.command ?? '') ||
    !jsonEqual(profile.stdio?.args ?? [], draft.stdio?.args ?? []) ||
    (profile.stdio?.cwd ?? '') !== (draft.stdio?.cwd ?? '') ||
    !jsonEqual(
      (profile.stdio?.env ?? []).map((e) => ({ key: e.key, valuePresent: e.valuePresent })),
      (draft.stdio?.env ?? []).map((e) => ({ key: e.key, valuePresent: e.valuePresent }))
    ) ||
    (profile.http?.endpoint ?? '') !== (draft.http?.endpoint ?? '') ||
    !jsonEqual(profile.enabledToolNames, draft.enabledToolNames) ||
    profile.toolConfirmPolicy !== draft.toolConfirmPolicy ||
    (draft.clearSecretKinds?.length ?? 0) > 0 ||
    (draft.stdio?.env.some((e) => e.clear) ?? false)
  )
}
