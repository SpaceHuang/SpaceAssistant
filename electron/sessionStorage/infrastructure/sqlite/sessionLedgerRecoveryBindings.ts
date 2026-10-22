import path from 'node:path'
import { getSessionLedgerRoots } from '../../../storage/sessionLedgerRoots'
import type {
  SessionLedgerRecoveryBindings,
  SessionLedgerRecoveryLocationInput,
  SessionLedgerToolCallProjectionInput,
  SessionLedgerToolResultProjectionInput
} from '../../host/ports'

function resolveLocation(input: SessionLedgerRecoveryLocationInput) {
  if (!input.sessionId.trim() || !Number.isFinite(input.createdAt)) return undefined
  let profiles: Array<{ id: string; path: string }> = []
  if (input.profilesJson) {
    try {
      const parsed: unknown = JSON.parse(input.profilesJson)
      if (Array.isArray(parsed)) profiles = parsed.filter((entry): entry is { id: string; path: string } =>
        Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry) &&
        typeof (entry as { id?: unknown }).id === 'string' && typeof (entry as { path?: unknown }).path === 'string' &&
        Boolean((entry as { id: string }).id.trim()) && Boolean((entry as { path: string }).path.trim()))
    } catch { /* Keep configuredWorkDir as the only safe fallback. */ }
  }
  const profileId = input.workDirProfileId?.trim() || input.activeProfileId?.trim()
  const profile = profileId ? profiles.find((entry) => entry.id === profileId) : undefined
  if (input.workDirProfileId?.trim() && !profile) return undefined
  const workDir = profile?.path ?? input.configuredWorkDir
  if (!workDir.trim()) return undefined
  return { workDir: path.resolve(workDir), sessionId: input.sessionId, createdAt: input.createdAt }
}

function toToolCallProjection(input: SessionLedgerToolCallProjectionInput) {
  return {
    toolUseId: input.toolUseId,
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    stepId: input.stepId,
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    ...(input.invocationRequestId !== undefined ? { invocationRequestId: input.invocationRequestId } : {}),
    ...(input.lane !== undefined ? { lane: input.lane } : {}),
    name: input.name,
    args: input.args
  }
}

function toToolResultProjection(input: SessionLedgerToolResultProjectionInput) {
  return {
    toolUseId: input.toolUseId,
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    stepId: input.stepId,
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    ...(input.invocationRequestId !== undefined ? { invocationRequestId: input.invocationRequestId } : {}),
    ...(input.lane !== undefined ? { lane: input.lane } : {}),
    result: input.result
  }
}

/** Bind workspace-root facts to the host recovery port; ledger locations require exact root identity. */
export function createSessionLedgerRecoveryBindings(): SessionLedgerRecoveryBindings {
  const bindings: SessionLedgerRecoveryBindings = {
    getAllowedRoots: ({ configuredWorkDir, profilesJson }) => getSessionLedgerRoots(configuredWorkDir, profilesJson),
    isLocationAllowed: ({ location, allowedRoots }) => {
      if (typeof location.workDir !== 'string' || !location.workDir.trim()) return false
      const target = path.resolve(location.workDir)
      return allowedRoots.some((root) => path.resolve(root) === target)
    },
    resolveLocation,
    toToolCallProjection,
    toToolResultProjection
  }
  return Object.freeze(bindings)
}
