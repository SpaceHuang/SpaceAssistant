import type { SkillActivationLogEntry } from '../../shared/domainTypes'

const MAX_LOG = 20

export function appendSkillActivationLog(
  metadata: Record<string, unknown>,
  entry: Omit<SkillActivationLogEntry, 'timestamp'>
): Record<string, unknown> {
  const prev = Array.isArray(metadata.skillActivationLog)
    ? (metadata.skillActivationLog as SkillActivationLogEntry[])
    : []
  const next: SkillActivationLogEntry[] = [{ ...entry, timestamp: Date.now() }, ...prev].slice(0, MAX_LOG)
  console.info('[Skill] activated', entry)
  return { ...metadata, skillActivationLog: next }
}

export function readSkillActivationLog(metadata: Record<string, unknown>): SkillActivationLogEntry[] {
  return Array.isArray(metadata.skillActivationLog) ? (metadata.skillActivationLog as SkillActivationLogEntry[]) : []
}
