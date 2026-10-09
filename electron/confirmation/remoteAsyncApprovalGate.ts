import { getDbConnection, type AppDatabase } from '../database/sqliteStore'

export type RemoteAsyncApprovalGateEvidence = {
  safetyReview: { status: 'approved' | 'pending'; reviewId: string }
  controls: Record<`P1-${1 | 2 | 3 | 4 | 5 | 6 | 7}`, { passed: boolean; evidenceId: string }>
  integrationRuns: Record<'6.5.16' | '6.5.17' | '6.5.18' | '6.5.19', {
    passed: boolean; realStores: boolean; realDispatcher: boolean; onlyFinalExecutorFake: boolean; runId: string
  }>
  decisions: Record<`OQ-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`, 'resolved' | 'pending'>
  groupChatPolicy: 'reject' | 'allow'
}

export function isRemoteAsyncApprovalGateEnabled(db: AppDatabase | null | undefined): boolean {
  if (!db) return false
  try {
    const row = getDbConnection(db).prepare(`SELECT state,close_required FROM remote_async_approval_gate_state WHERE singleton=1`)
      .get() as { state: string; close_required: number } | undefined
    return row?.state === 'enabled' && row.close_required === 0
  } catch {
    return false
  }
}

export function evaluateRemoteAsyncApprovalGate(evidence: RemoteAsyncApprovalGateEvidence | null | undefined): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = []
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

type GateState = { state: 'disabled' | 'enabled' | 'closing'; enabled: boolean; closeRequired: boolean }
type CloseResult = { status: 'closed' | 'reconciliation_required' }

export function createRemoteAsyncApprovalGate(input: {
  db: AppDatabase
  getEvidence: () => RemoteAsyncApprovalGateEvidence | null | undefined
  closeAll: () => Promise<CloseResult>
}) {
  const conn = getDbConnection(input.db)
  function state(): GateState {
    const row = conn.prepare('SELECT state,close_required FROM remote_async_approval_gate_state WHERE singleton=1')
      .get() as { state: GateState['state']; close_required: number } | undefined
    const value = row ?? { state: 'disabled' as const, close_required: 0 }
    return { state: value.state, enabled: value.state === 'enabled', closeRequired: value.close_required === 1 }
  }
  function write(next: GateState['state'], closeRequired: boolean): GateState {
    conn.prepare(`INSERT INTO remote_async_approval_gate_state(singleton,state,close_required,updated_at) VALUES(1,?,?,?)
      ON CONFLICT(singleton) DO UPDATE SET state=excluded.state,close_required=excluded.close_required,updated_at=excluded.updated_at`)
      .run(next, closeRequired ? 1 : 0, Date.now())
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
    isEnabled: () => state().enabled,
    async setEnabled(enabled: boolean): Promise<GateState> {
      if (enabled) {
        const evaluation = evaluateRemoteAsyncApprovalGate(input.getEvidence())
        if (!evaluation.allowed) return state()
        return write('enabled', false)
      }
      if (state().state === 'disabled' && !state().closeRequired) return state()
      write('closing', true)
      return reconcilePendingClose()
    },
    reconcilePendingClose
  }
}
