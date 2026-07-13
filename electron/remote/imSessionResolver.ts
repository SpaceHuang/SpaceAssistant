import type { AppDatabase } from '../database'
import { listSessions } from '../database'
import type { Session } from '../../src/shared/domainTypes'
import type { RemoteImCommonConfig } from '../../src/shared/imTypes'
import {
  pickRemoteSessionCandidate,
  readRemoteSessionIdleMinutes,
  resolveActivityAt
} from '../../src/shared/remoteSessionResolve'

export function truncateTitle(content: string, max = 30): string {
  const t = content.trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

export type ImSessionResolveConfig = Pick<
  RemoteImCommonConfig,
  'remoteDefaultModelId' | 'remoteSessionIdleMinutes' | 'remoteSessionMergeMinutes'
>

export async function resolveImSession(args: {
  db: AppDatabase
  config: ImSessionResolveConfig
  defaultModel: string
  availableModelNames?: string[]
  channel: 'feishu' | 'wechat'
  identityKey: string
  getIdentityFromSession: (s: Session) => string | undefined
  createNew: (model: string) => Promise<string>
  onReuse: (existing: Session) => void
}): Promise<{ sessionId: string; isNew: boolean }> {
  let model = args.config.remoteDefaultModelId ?? args.defaultModel
  if (
    args.config.remoteDefaultModelId &&
    args.availableModelNames &&
    !args.availableModelNames.includes(model)
  ) {
    model = args.defaultModel
  }

  const idleTimeoutMs = readRemoteSessionIdleMinutes(args.config) * 60_000
  if (idleTimeoutMs <= 0) {
    return { sessionId: await args.createNew(model), isNew: true }
  }

  const existing = pickRemoteSessionCandidate(
    listSessions(args.db),
    args.channel,
    args.identityKey,
    args.getIdentityFromSession
  )

  if (existing && Date.now() - resolveActivityAt(existing) < idleTimeoutMs) {
    args.onReuse(existing)
    return { sessionId: existing.id, isNew: false }
  }

  return { sessionId: await args.createNew(model), isNew: true }
}
