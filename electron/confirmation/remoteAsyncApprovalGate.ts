import { getDbConnection, type AppDatabase } from '../database/sqliteStore'

/** Bump for any release that changes IM approval or rollback behavior. */
export const CURRENT_REMOTE_ASYNC_APPROVAL_BEHAVIOR_VERSION = 'im-standard-v2:im-security-review-2026-10-13-v1'

export type RemoteAsyncApprovalGateEvidence = {
  /** Opaque release identifier binding this review to code and policy behavior. */
  behaviorVersion: string
  safetyReview: { status: 'approved' | 'pending'; reviewId: string }
  controls: Record<`P1-${1 | 2 | 3 | 4 | 5 | 6 | 7}`, { passed: boolean; evidenceId: string }>
  integrationRuns: Record<'6.5.16' | '6.5.17' | '6.5.18' | '6.5.19', {
    passed: boolean; realStores: boolean; realDispatcher: boolean; onlyFinalExecutorFake: boolean; runId: string
  }>
  decisions: Record<`OQ-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`, 'resolved' | 'pending'>
  groupChatPolicy: 'reject' | 'allow'
}

export function isRemoteAsyncApprovalGateEnabled(
  db: AppDatabase | null | undefined,
  currentBehaviorVersion = CURRENT_REMOTE_ASYNC_APPROVAL_BEHAVIOR_VERSION
): boolean {
  if (!currentBehaviorVersion.trim()) return false
  if (!db) return false
  try {
    const row = getDbConnection(db).prepare(`SELECT state,close_required,behavior_version FROM remote_async_approval_gate_state WHERE singleton=1`)
      .get() as { state: string; close_required: number; behavior_version: string } | undefined
    return row?.state === 'enabled' && row.close_required === 0 && row.behavior_version === currentBehaviorVersion
  } catch {
    return false
  }
}

export function evaluateRemoteAsyncApprovalGate(evidence: RemoteAsyncApprovalGateEvidence | null | undefined): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (!evidence?.behaviorVersion?.trim()) reasons.push('behavior-version-missing')
  if (!evidence?.safetyReview || evidence.safetyReview.status !== 'approved' || !evidence.safetyReview.reviewId.trim()) reasons.push('safety-review-not-approved')
  for (let id = 1; id <= 7; id += 1) {
    const item = evidence?.controls?.[`P1-${id}` as keyof RemoteAsyncApprovalGateEvidence['controls']]
    if (!item?.passed || !item.evidenceId?.trim()) reasons.push(`missing-control-evidence:P1-${id}`)
  }
  for (const id of ['6.5.16', '6.5.17', '6.5.18', '6.5.19'] as const) {
    const item = evidence?.integrationRuns?.[id]
    if (!item?.passed || !item.realStores || !item.realDispatcher || !item.onlyFinalExecutorFake || !item.runId?.trim()) reasons.push(`invalid-integration-evidence:${id}`)
  }
  for (let id = 1; id <= 8; id += 1) {
    if (evidence?.decisions?.[`OQ-${id}` as keyof RemoteAsyncApprovalGateEvidence['decisions']] !== 'resolved') reasons.push(`unresolved-decision:OQ-${id}`)
  }
  if (evidence?.groupChatPolicy !== 'reject') reasons.push('group-chat-policy-must-reject')
  return { allowed: reasons.length === 0, reasons }
}

type GateState = { state: 'disabled' | 'enabled' | 'closing'; enabled: boolean; closeRequired: boolean; behaviorVersion: string }
type CloseResult = { status: 'closed' | 'reconciliation_required' }

export function createRemoteAsyncApprovalGate(input: {
  db: AppDatabase
  getEvidence: () => RemoteAsyncApprovalGateEvidence | null | undefined
  currentBehaviorVersion?: string
  closeAll: () => Promise<CloseResult>
}) {
  const conn = getDbConnection(input.db)
  const currentBehaviorVersion = input.currentBehaviorVersion ?? CURRENT_REMOTE_ASYNC_APPROVAL_BEHAVIOR_VERSION
  function state(): GateState {
    const row = conn.prepare('SELECT state,close_required,behavior_version FROM remote_async_approval_gate_state WHERE singleton=1')
      .get() as { state: GateState['state']; close_required: number; behavior_version: string } | undefined
    const value = row ?? { state: 'disabled' as const, close_required: 0 }
    const behaviorVersion = 'behavior_version' in value ? value.behavior_version : ''
    return { state: value.state, enabled: value.state === 'enabled' && value.close_required === 0 && behaviorVersion === currentBehaviorVersion,
      closeRequired: value.close_required === 1, behaviorVersion }
  }
  function write(next: GateState['state'], closeRequired: boolean, behaviorVersion = ''): GateState {
    conn.prepare(`INSERT INTO remote_async_approval_gate_state(singleton,state,close_required,behavior_version,updated_at) VALUES(1,?,?,?,?)
      ON CONFLICT(singleton) DO UPDATE SET state=excluded.state,close_required=excluded.close_required,behavior_version=excluded.behavior_version,updated_at=excluded.updated_at`)
      .run(next, closeRequired ? 1 : 0, behaviorVersion, Date.now())
    input.db.save()
    return state()
  }
  async function reconcilePendingClose(): Promise<GateState> {
    const current = state()
    if (!current.closeRequired) return current
    const result = await input.closeAll()
    return result.status === 'closed' ? write('disabled', false) : write('closing', true)
  }
  return {
    getState: state,
    isEnabled: () => {
      const current = state()
      const evidence = input.getEvidence()
      return current.enabled && Boolean(currentBehaviorVersion.trim()) && evidence?.behaviorVersion === currentBehaviorVersion
    },
    async setEnabled(enabled: boolean): Promise<GateState> {
      if (enabled) {
        const current = state()
        if (!currentBehaviorVersion.trim()) return current
        if (current.state === 'enabled') {
          const currentEvidence = input.getEvidence()
          if (current.behaviorVersion === currentBehaviorVersion && currentEvidence?.behaviorVersion === currentBehaviorVersion) return current
          write('closing', true)
          return reconcilePendingClose()
        }
        // A prior close must finish revocation/reconciliation before a fresh enable.
        // Otherwise old approvals or in-flight work could cross the close boundary.
        if (current.state !== 'disabled' || current.closeRequired) return current
        const evaluation = evaluateRemoteAsyncApprovalGate(input.getEvidence())
        if (!evaluation.allowed || input.getEvidence()?.behaviorVersion !== currentBehaviorVersion) return state()
        return write('enabled', false, currentBehaviorVersion)
      }
      if (state().state === 'disabled' && !state().closeRequired) return state()
      write('closing', true)
      return reconcilePendingClose()
    },
    reconcilePendingClose
  }
}
