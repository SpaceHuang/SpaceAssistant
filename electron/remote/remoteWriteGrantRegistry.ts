/**
 * Remote session-scoped write authorization (WP1).
 * Grants bind channel + owner + originSessionId + workDirProfileId + authorizationGeneration.
 * Budget: 30 min / 500 writes / 50 MiB. In-memory only — gone on app restart.
 */

import { randomBytes } from 'crypto'
import type { RemoteAuthChannel } from './remoteAuthorizationRegistry'

export type WriteGrantRevokeReason = string

export type RemoteWriteGrant = {
  grantId: string
  channel: RemoteAuthChannel
  owner: string
  originSessionId: string
  workDirProfileId: string
  authorizationGeneration: number
  createdAt: number
  expiresAt: number
  remainingOps: number
  remainingBytes: number
}

export const REMOTE_WRITE_GRANT_TTL_MS = 30 * 60_000
export const REMOTE_WRITE_GRANT_MAX_OPS = 500
export const REMOTE_WRITE_GRANT_MAX_BYTES = 50 * 1024 * 1024

export type WriteGrantRevokeListener = (originSessionId: string, reason: WriteGrantRevokeReason) => number | void
export type WriteGrantChannelRevokeListener = (channel: string, reason: WriteGrantRevokeReason) => number | void

export type ReserveResult =
  | { ok: true; grant: RemoteWriteGrant }
  | {
      ok: false
      reason:
        | 'missing'
        | 'expired'
        | 'budget'
        | 'generation_mismatch'
        | 'workdir_mismatch'
        | 'owner_mismatch'
    }

export class RemoteWriteGrantRegistry {
  private grants = new Map<string, RemoteWriteGrant>()
  private originListeners: WriteGrantRevokeListener[] = []
  private channelListeners: WriteGrantChannelRevokeListener[] = []

  private key(
    channel: RemoteAuthChannel,
    owner: string,
    originSessionId: string,
    workDirProfileId: string
  ): string {
    return `${channel}:${owner}:${originSessionId}:${workDirProfileId}`
  }

  onRevokeByOriginSession(listener: WriteGrantRevokeListener): () => void {
    this.originListeners.push(listener)
    return () => {
      const idx = this.originListeners.indexOf(listener)
      if (idx >= 0) this.originListeners.splice(idx, 1)
    }
  }

  onRevokeByChannel(listener: WriteGrantChannelRevokeListener): () => void {
    this.channelListeners.push(listener)
    return () => {
      const idx = this.channelListeners.indexOf(listener)
      if (idx >= 0) this.channelListeners.splice(idx, 1)
    }
  }

  issue(args: {
    channel: RemoteAuthChannel
    owner: string
    originSessionId: string
    workDirProfileId: string
    authorizationGeneration: number
    now?: number
  }): RemoteWriteGrant {
    const now = args.now ?? Date.now()
    const grant: RemoteWriteGrant = {
      grantId: randomBytes(8).toString('hex'),
      channel: args.channel,
      owner: args.owner,
      originSessionId: args.originSessionId,
      workDirProfileId: args.workDirProfileId,
      authorizationGeneration: args.authorizationGeneration,
      createdAt: now,
      expiresAt: now + REMOTE_WRITE_GRANT_TTL_MS,
      remainingOps: REMOTE_WRITE_GRANT_MAX_OPS,
      remainingBytes: REMOTE_WRITE_GRANT_MAX_BYTES
    }
    this.grants.set(
      this.key(args.channel, args.owner, args.originSessionId, args.workDirProfileId),
      grant
    )
    return grant
  }

  findActive(args: {
    channel: RemoteAuthChannel
    owner: string
    originSessionId: string
    workDirProfileId: string
    authorizationGeneration: number
    now?: number
  }): RemoteWriteGrant | null {
    const k = this.key(args.channel, args.owner, args.originSessionId, args.workDirProfileId)
    const g = this.grants.get(k)
    if (!g) return null
    const now = args.now ?? Date.now()
    if (g.expiresAt <= now) {
      this.grants.delete(k)
      return null
    }
    if (g.owner !== args.owner) return null
    if (g.authorizationGeneration !== args.authorizationGeneration) return null
    if (g.remainingOps <= 0 || g.remainingBytes <= 0) return null
    return g
  }

  /** Synchronous budget reserve before write execution. */
  reserve(args: {
    channel: RemoteAuthChannel
    owner: string
    originSessionId: string
    workDirProfileId: string
    authorizationGeneration: number
    byteCount: number
    now?: number
  }): ReserveResult {
    const g = this.findActive(args)
    if (!g) return { ok: false, reason: 'missing' }
    if (g.owner !== args.owner) return { ok: false, reason: 'owner_mismatch' }
    if (g.workDirProfileId !== args.workDirProfileId) return { ok: false, reason: 'workdir_mismatch' }
    if (g.authorizationGeneration !== args.authorizationGeneration) {
      return { ok: false, reason: 'generation_mismatch' }
    }
    const now = args.now ?? Date.now()
    if (g.expiresAt <= now) return { ok: false, reason: 'expired' }
    if (g.remainingOps < 1 || g.remainingBytes < args.byteCount) {
      return { ok: false, reason: 'budget' }
    }
    g.remainingOps -= 1
    g.remainingBytes -= args.byteCount
    return { ok: true, grant: g }
  }

  revokeByOriginSession(originSessionId: string, reason: WriteGrantRevokeReason = 'manual'): number {
    let n = 0
    for (const [k, g] of [...this.grants.entries()]) {
      if (g.originSessionId === originSessionId) {
        this.grants.delete(k)
        n++
      }
    }
    for (const listener of this.originListeners) {
      try {
        n += listener(originSessionId, reason) ?? 0
      } catch {
        /* ignore */
      }
    }
    return n
  }

  revokeByChannel(channel: string, reason: WriteGrantRevokeReason = 'manual'): number {
    let n = 0
    for (const [k, g] of [...this.grants.entries()]) {
      if (g.channel === channel) {
        this.grants.delete(k)
        n++
      }
    }
    for (const listener of this.channelListeners) {
      try {
        n += listener(channel, reason) ?? 0
      } catch {
        /* ignore */
      }
    }
    return n
  }

  /** Test helper */
  clearAll(): void {
    this.grants.clear()
  }
}

export const remoteWriteGrantRegistry = new RemoteWriteGrantRegistry()

/** Prompt template fields required for remote_write_grant confirm. */
export function buildRemoteWriteGrantPrompt(args: {
  sessionLabel: string
  workDirName: string
  confirmId?: string
}): string {
  const idHint = args.confirmId ? ` ${args.confirmId}` : ' <确认码>'
  return [
    '当前远程会话在指定工作目录内的临时文件写入授权',
    `会话：${args.sessionLabel}`,
    `工作目录：${args.workDirName}`,
    '有效期：30 分钟',
    '次数上限：500 次',
    '累计输入上限：50 MiB',
    '仅覆盖 write_file / edit_file',
    '不包含 shell、脚本、浏览器或消息发送',
    `回复 Y${idHint} 确认，N${idHint} 取消`
  ].join('\n')
}
