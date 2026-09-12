import { createHash } from 'crypto'
import fs from 'fs/promises'
import type { ShellDialect } from './shellProfiles'
import type { OutputEncodingContract } from '../../src/shared/outputEncoding'

export interface PreparedShellExecution {
  readonly command: string
  readonly profile: {
    readonly id: string
    readonly dialect: ShellDialect
    readonly executable: string
    readonly outputEncoding: OutputEncodingContract
  }
  readonly spawnSpec: {
    readonly executable: string
    readonly args: readonly string[]
    readonly shellId: string
  }
  readonly cwd: string
  readonly timeoutMs: number
  readonly ioMaxBytes: number
  readonly environment: Readonly<Record<string, string>>
  readonly environmentFingerprint: string
  readonly facts: unknown
  readonly configRevision: string
  readonly policyRevision: string
  readonly dependencySnapshot: Readonly<Record<string, string>>
  readonly pathSnapshot: Readonly<Record<string, string>>
  readonly planDigest: string
}

export interface PreparedShellInput {
  command: string
  profile: PreparedShellExecution['profile']
  spawnSpec: PreparedShellExecution['spawnSpec']
  cwd: string
  timeoutMs: number
  ioMaxBytes: number
  environment: Record<string, string>
  facts: unknown
  configRevision: string
  policyRevision: string
  dependencySnapshot?: Record<string, string>
  pathSnapshot?: Record<string, string>
}

export class PreparedShellStaleError extends Error {
  readonly code = 'PLAN_STALE'
  constructor(readonly reasons: readonly string[]) {
    super(`PLAN_STALE:${reasons.join(',')}`)
    this.name = 'PreparedShellStaleError'
  }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex')
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
  }
  return value
}

export function prepareShellExecution(input: PreparedShellInput): PreparedShellExecution {
  const snapshot = structuredClone(input)
  snapshot.pathSnapshot ??= {}
  snapshot.dependencySnapshot ??= {}
  const environmentFingerprint = digest(snapshot.environment)
  return freeze({
    ...snapshot,
    profile: snapshot.profile,
    spawnSpec: snapshot.spawnSpec,
    environment: snapshot.environment,
    dependencySnapshot: snapshot.dependencySnapshot ?? {},
    pathSnapshot: snapshot.pathSnapshot ?? {},
    environmentFingerprint,
    planDigest: digest({ ...snapshot, environmentFingerprint })
  })
}

export function validatePreparedShellExecution(
  prepared: PreparedShellExecution,
  current: Pick<PreparedShellInput, 'profile' | 'spawnSpec' | 'cwd' | 'timeoutMs' | 'environment' | 'configRevision' | 'policyRevision' | 'dependencySnapshot' | 'pathSnapshot'>
): { stale: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (stable(prepared.profile) !== stable(current.profile)) reasons.push('profile')
  if (stable(prepared.spawnSpec) !== stable(current.spawnSpec)) reasons.push('spawnSpec')
  if (prepared.cwd !== current.cwd) reasons.push('cwd')
  if (prepared.timeoutMs !== current.timeoutMs) reasons.push('timeout')
  if (prepared.environmentFingerprint !== digest(current.environment)) reasons.push('environment')
  if (prepared.configRevision !== current.configRevision) reasons.push('configRevision')
  if (prepared.policyRevision !== current.policyRevision) reasons.push('policyRevision')
  if (stable(prepared.dependencySnapshot) !== stable(current.dependencySnapshot ?? {})) reasons.push('dependencySnapshot')
  if (stable(prepared.pathSnapshot) !== stable(current.pathSnapshot ?? {})) reasons.push('pathSnapshot')
  return { stale: reasons.length > 0, reasons }
}

export function assertPreparedShellExecutionCurrent(
  prepared: PreparedShellExecution,
  current: Parameters<typeof validatePreparedShellExecution>[1]
): void {
  const result = validatePreparedShellExecution(prepared, current)
  if (result.stale) throw new PreparedShellStaleError(result.reasons)
}

/** Capture the resolved targets of executable/cwd before confirmation. Missing paths use lexical path. */
export async function captureShellPathSnapshot(paths: readonly string[]): Promise<Record<string, string>> {
  const entries = await Promise.all(paths.map(async (target) => {
    try {
      return [target, await fs.realpath(target)] as const
    } catch {
      return [target, target] as const
    }
  }))
  return Object.fromEntries(entries)
}
