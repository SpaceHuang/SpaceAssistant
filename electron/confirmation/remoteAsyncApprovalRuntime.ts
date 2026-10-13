import type { AppDatabase } from '../database/sqliteStore'
import { isRemoteAsyncApprovalGateEnabled } from './remoteAsyncApprovalGate'
import { isRemoteAsyncApprovalTestModeEnabled } from './remoteAsyncApprovalTestMode'

/** The development switch exercises the same IM flow without changing release-gate state. */
export function isRemoteAsyncApprovalEnabledForRuntime(db: AppDatabase | null | undefined): boolean {
  return isRemoteAsyncApprovalGateEnabled(db) || isRemoteAsyncApprovalTestModeEnabled()
}
