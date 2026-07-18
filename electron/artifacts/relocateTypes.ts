import type { FileIdentity } from '../safeAtomicWrite'

export type RelocatePhase =
  | 'prepared'
  | 'backup_committed'
  | 'target_committed'
  | 'source_cleanup_pending'
  | 'cleanup_pending'
  | 'completed'
  | 'rolled_back'
  | 'recovery_required'

export type RelocateMoveMode = 'same-device-move' | 'cross-device-move' | 'copy'

export const TERMINAL_RELOCATE_PHASES: readonly RelocatePhase[] = [
  'completed',
  'rolled_back',
  'recovery_required'
]

export type ArtifactOperationRecord = {
  id: string
  artifactId: string
  operation: 'relocate'
  moveMode: RelocateMoveMode
  sourcePath: string
  targetPath: string
  tempPath?: string
  targetExisted: boolean
  targetBackupPath?: string
  targetBackupIdentity?: FileIdentity
  targetOriginalIdentity?: FileIdentity
  targetOriginalSize?: number
  targetOriginalDigest?: string
  expectedSize?: number
  expectedDigest?: string
  tempIdentity?: FileIdentity
  phase: RelocatePhase
  error?: string
  createdAt: number
  updatedAt: number
}

export type RelocateRequest = {
  sessionId: string
  artifactId: string
  target: string
  mode: 'move' | 'copy'
  switchToCopy?: boolean
  overwriteAuthorized?: boolean
}

export type RelocateResult =
  | { ok: true; artifactId: string; activeArtifactId: string }
  | { ok: false; error: string }
