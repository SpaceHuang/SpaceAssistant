export type ProjectionStateStatus = 'invalid' | 'rebuilding' | 'valid' | 'rejected'

export const MAX_INLINE_PROJECTION_PAYLOAD_BYTES = 256 * 1024

export interface ProjectionStateRecord {
  sessionId: string
  scopeKey: string
  sessionGeneration: string
  status: ProjectionStateStatus
  historyWatermarkJson: string | null
  messageRevision: number | null
  payloadGeneration: string | null
  payloadDigest: string | null
  validatedRangeJson: string | null
  sourceIdentityJson: string | null
  processGeneration: number | null
  rebuildToken: string | null
  failureCaseJson: string | null
  attempts: number
  retryAfter: number | null
  updatedAt: number
}

export type ProjectionStateCommand =
  | Readonly<{ type: 'claim'; processGeneration: number; rebuildToken: string; now: number }>
  | Readonly<{
      type: 'publish'; processGeneration: number; rebuildToken: string; expectedSourceIdentityJson: string
      historyWatermarkJson: string; messageRevision: number
      payloadGeneration: string; payloadDigest: string; validatedRangeJson: string; now: number
    }>
  | Readonly<{ type: 'reject'; processGeneration: number; rebuildToken: string; failureCaseJson: string; attempts: number; retryAfter: number; now: number }>
  | Readonly<{ type: 'scheduleRetry'; expectedFailureCaseJson: string; failureCaseJson: string; retryAfter: number; now: number }>
  | Readonly<{ type: 'invalidate'; sessionGeneration: string; now: number }>

/** Pure projection eligibility reducer. Durable callers must persist the returned row with a CAS. */
export function transitionProjectionState(
  current: ProjectionStateRecord,
  command: ProjectionStateCommand,
  currentSourceIdentityJson?: string
): ProjectionStateRecord | null {
  if (command.type === 'invalidate') {
    if (current.sessionGeneration !== command.sessionGeneration) return null
    return {
      ...current,
      status: 'invalid', historyWatermarkJson: null, messageRevision: null, payloadGeneration: null,
      payloadDigest: null, validatedRangeJson: null, sourceIdentityJson: null, processGeneration: null,
      rebuildToken: null, failureCaseJson: null, attempts: 0, retryAfter: null, updatedAt: command.now,
    }
  }

  if (command.type === 'claim') {
    const claimable = current.status === 'invalid' || (current.status === 'rejected' && current.retryAfter !== null && current.retryAfter <= command.now)
    const takeover = current.status === 'rebuilding' && current.processGeneration !== null && command.processGeneration > current.processGeneration
    if ((!claimable && !takeover) || command.rebuildToken.length === 0 || command.processGeneration < 0) return null
    return {
      ...current, status: 'rebuilding', historyWatermarkJson: null, messageRevision: null,
      payloadGeneration: null, payloadDigest: null, validatedRangeJson: null,
      sourceIdentityJson: currentSourceIdentityJson ?? null, processGeneration: command.processGeneration,
      rebuildToken: command.rebuildToken, failureCaseJson: null, retryAfter: null, updatedAt: command.now,
    }
  }

  if (command.type === 'scheduleRetry') {
    if (current.status !== 'rejected' || current.failureCaseJson !== command.expectedFailureCaseJson ||
      !command.failureCaseJson || command.retryAfter < command.now) return null
    return { ...current, failureCaseJson: command.failureCaseJson, retryAfter: command.retryAfter, updatedAt: command.now }
  }

  const ownsRebuild = current.status === 'rebuilding' && current.processGeneration === command.processGeneration && current.rebuildToken === command.rebuildToken
  if (!ownsRebuild) return null

  if (command.type === 'publish') {
    if (current.sourceIdentityJson !== command.expectedSourceIdentityJson) return null
    if (currentSourceIdentityJson !== command.expectedSourceIdentityJson) {
      return transitionProjectionState(current, { type: 'invalidate', sessionGeneration: current.sessionGeneration, now: command.now })
    }
    if (command.messageRevision < 0 || command.payloadGeneration.length === 0 || command.payloadDigest.length === 0) return null
    return {
      ...current, status: 'valid', historyWatermarkJson: command.historyWatermarkJson,
      messageRevision: command.messageRevision, payloadGeneration: command.payloadGeneration,
      payloadDigest: command.payloadDigest, validatedRangeJson: command.validatedRangeJson,
      processGeneration: null, rebuildToken: null, failureCaseJson: null, attempts: 0, retryAfter: null, updatedAt: command.now,
    }
  }

  if (command.attempts < 0 || command.retryAfter < command.now || command.failureCaseJson.length === 0) return null
  return {
    ...current, status: 'rejected', historyWatermarkJson: null, messageRevision: null,
    payloadGeneration: null, payloadDigest: null, validatedRangeJson: null, processGeneration: null,
    sourceIdentityJson: null, rebuildToken: null, failureCaseJson: command.failureCaseJson, attempts: command.attempts,
    retryAfter: command.retryAfter, updatedAt: command.now,
  }
}
