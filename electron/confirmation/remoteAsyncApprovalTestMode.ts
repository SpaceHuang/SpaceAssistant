import { randomUUID } from 'node:crypto'

let enabled = false
let activeRunId: string | null = null

/** Process-local test switch for unpackaged development builds; never persisted. */
export function isRemoteAsyncApprovalTestModeEnabled(): boolean {
  return enabled
}

export function getRemoteAsyncApprovalTestRunId(): string | null {
  return enabled ? activeRunId : null
}

export function remoteAsyncApprovalTestRunIdFromPolicyVersion(policyBehaviorVersion: string | undefined): string | null {
  if (typeof policyBehaviorVersion !== 'string') return null
  const match = /:dev-test:([0-9a-f-]{36})$/.exec(policyBehaviorVersion)
  return match?.[1] ?? null
}

export function isRemoteAsyncApprovalTestPolicyVersionEnabled(policyBehaviorVersion: string | undefined): boolean {
  const todoRunId = remoteAsyncApprovalTestRunIdFromPolicyVersion(policyBehaviorVersion)
  return enabled && activeRunId !== null && todoRunId === activeRunId
}

export function isRemoteAsyncApprovalTestTodoEnabled(todo: { policyBehaviorVersion?: string }): boolean {
  return isRemoteAsyncApprovalTestPolicyVersionEnabled(todo.policyBehaviorVersion)
}

export function setRemoteAsyncApprovalTestModeEnabled(value: boolean, isPackaged: boolean): boolean {
  if (isPackaged) throw new Error('REMOTE_ASYNC_APPROVAL_TEST_MODE_UNAVAILABLE')
  if (typeof value !== 'boolean') throw new Error('REMOTE_ASYNC_APPROVAL_TEST_MODE_INVALID')
  if (value && !enabled) activeRunId = randomUUID()
  if (!value) activeRunId = null
  enabled = value
  return enabled
}
