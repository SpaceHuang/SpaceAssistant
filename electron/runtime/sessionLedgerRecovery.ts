import path from 'node:path'
import { projectAgentToolResult, type AgentToolResultInput } from '../../src/shared/agentToolResult'
import { isProcessToolName } from '../../src/shared/processResultProjection'

/** Recomputes the safe SessionEvent result from the canonical SDK completion payload. */
export function projectCanonicalToolResultForSessionLedger(input: {
  rawResult: unknown
  isError: boolean
  toolName?: string
  workspaceRoot?: string
  auditRef?: string
  deferredUnsurfaced?: boolean
}): AgentToolResultInput {
  const record = input.rawResult && typeof input.rawResult === 'object' && !Array.isArray(input.rawResult)
    ? input.rawResult as Record<string, unknown>
    : undefined
  const result = projectAgentToolResult({
    success: typeof record?.success === 'boolean' ? record.success : !input.isError,
    ...('data' in (record ?? {}) ? { data: record!.data } : { data: input.rawResult }),
    ...(typeof record?.error === 'string' ? { error: record.error } : {}),
    ...(typeof record?.userMessage === 'string' ? { userMessage: record.userMessage } : {}),
    ...(typeof record?.decisionRuleId === 'string' ? { decisionRuleId: record.decisionRuleId } : {}),
    ...(record?.autoApprovedWrite && typeof record.autoApprovedWrite === 'object'
      ? { autoApprovedWrite: record.autoApprovedWrite as import('../../src/shared/domainTypes').AutoApprovedWriteMeta }
      : {})
  }, { ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}), processTool: isProcessToolName(input.toolName) })
  if (input.auditRef) result.auditRef = input.auditRef
  if (input.deferredUnsurfaced && !input.isError && record?.success !== false) result.deferredUnsurfaced = true
  return result
}

type CanonicalToolLedgerIdentity = {
  toolUseId: string; turnId?: string; stepId: string; requestId?: string; invocationRequestId?: string; lane?: string
}

/** Resolves a committed turn's ledger owner without guessing when a persisted profile reference is stale. */
export function resolveSessionLedgerLocation(input: {
  sessionId: string
  createdAt: number
  workDirProfileId?: string | null
  activeProfileId?: string
  configuredWorkDir: string
  profilesJson?: string
}): { workDir: string; sessionId: string; createdAt: number } | undefined {
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

/** Keeps canonical turn ownership when startup recovery narrows History sidecars to SessionEvent payloads. */
export function toSessionLedgerToolCallProjection(input: CanonicalToolLedgerIdentity & { name: string; args: Record<string, unknown> }): {
  toolUseId: string; turnId?: string; stepId: string; requestId?: string; invocationRequestId?: string; lane?: string; name: string; args: Record<string, unknown>
} {
  return {
    toolUseId: input.toolUseId, ...(input.turnId !== undefined ? { turnId: input.turnId } : {}), stepId: input.stepId,
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    ...(input.invocationRequestId !== undefined ? { invocationRequestId: input.invocationRequestId } : {}),
    ...(input.lane !== undefined ? { lane: input.lane } : {}), name: input.name, args: input.args
  }
}

/** Keeps canonical turn ownership when startup recovery narrows History sidecars to SessionEvent payloads. */
export function toSessionLedgerToolResultProjection(input: CanonicalToolLedgerIdentity & { result: Record<string, unknown> }): {
  toolUseId: string; turnId?: string; stepId: string; requestId?: string; invocationRequestId?: string; lane?: string; result: Record<string, unknown>
} {
  return {
    toolUseId: input.toolUseId, ...(input.turnId !== undefined ? { turnId: input.turnId } : {}), stepId: input.stepId,
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    ...(input.invocationRequestId !== undefined ? { invocationRequestId: input.invocationRequestId } : {}),
    ...(input.lane !== undefined ? { lane: input.lane } : {}), result: input.result
  }
}

/** Recovery may write only inside the configured workspace or a workspace profile root. */
export function getSessionLedgerRecoveryRoots(configuredWorkDir: string | undefined, profilesJson: string | undefined): string[] {
  const roots: string[] = []
  if (typeof configuredWorkDir === 'string' && configuredWorkDir.trim()) roots.push(path.resolve(configuredWorkDir))
  if (profilesJson) {
    try {
      const profiles: unknown = JSON.parse(profilesJson)
      if (Array.isArray(profiles)) {
        for (const profile of profiles) {
          if (!profile || typeof profile !== 'object' || Array.isArray(profile)) continue
          const profilePath = (profile as { path?: unknown }).path
          if (typeof profilePath === 'string' && profilePath.trim()) roots.push(path.resolve(profilePath))
        }
      }
    } catch {
      // Invalid profile configuration must not erase the primary configured workspace root.
    }
  }
  return [...new Set(roots)]
}

export function isSessionLedgerLocationAllowed(location: { workDir: string }, allowedRoots: readonly string[]): boolean {
  if (typeof location.workDir !== 'string' || !location.workDir.trim()) return false
  const target = path.resolve(location.workDir)
  return allowedRoots.some((root) => path.resolve(root) === target)
}
