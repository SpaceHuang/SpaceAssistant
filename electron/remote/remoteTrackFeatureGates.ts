import { getConfigValue, getDbConnection, runInTransaction, type AppDatabase } from '../database'
import { readRemoteTrackShadowGateReport } from './remoteTrackShadowGate'
import type { RemoteTrackChannel } from '../../src/shared/remoteTrack'

export const REMOTE_TRACK_ROLLOUT_CHANNELS_CONFIG_KEY = 'remoteTrackRolloutChannels'

export type RemoteTrackFeatureGates = Readonly<{
  persist: boolean
  shadowAttribution: boolean
  execution: boolean
  clarification: boolean
  recovery: boolean
  scopedModelInput: boolean
  confirmationLink: boolean
  semanticContinuation: boolean
}>

export type RemoteTrackGateConfiguration = Readonly<{
  version: 1
  gates: RemoteTrackFeatureGates
  rolloutChannels: readonly RemoteTrackChannel[]
}>

const CONFIG_KEYS: Record<keyof RemoteTrackFeatureGates, string> = {
  persist: 'remoteTrackPersist',
  shadowAttribution: 'remoteTrackShadowAttribution',
  execution: 'remoteTrackExecution',
  clarification: 'remoteTrackClarification',
  recovery: 'remoteTrackRecovery',
  scopedModelInput: 'remoteTrackScopedModelInput',
  confirmationLink: 'remoteTrackConfirmationLink',
  semanticContinuation: 'remoteTrackSemanticContinuation'
}

export function validateRemoteTrackFeatureGates(gates: RemoteTrackFeatureGates): string[] {
  const errors: string[] = []
  if ((gates.shadowAttribution || gates.execution) && !gates.persist) errors.push('persist-required')
  if (gates.execution && (!gates.recovery || !gates.scopedModelInput)) errors.push('execution-prerequisites-required')
  if (gates.clarification && !gates.execution) errors.push('clarification-requires-execution')
  if (gates.semanticContinuation && !gates.clarification) errors.push('semantic-continuation-requires-clarification')
  if (gates.semanticContinuation && !gates.shadowAttribution) errors.push('semantic-continuation-requires-shadow-observation')
  if (gates.confirmationLink && !gates.execution) errors.push('confirmation-link-requires-execution')
  return errors
}

export function parseRemoteTrackRolloutChannels(raw: string | undefined): RemoteTrackChannel[] | null {
  if (raw === undefined) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value) || value.some((channel) => channel !== 'wechat' && channel !== 'feishu') || new Set(value).size !== value.length) return null
    return value as RemoteTrackChannel[]
  } catch { return null }
}

/** Accepts only the complete, versioned operator configuration; partial and unknown fields fail closed. */
export function parseRemoteTrackGateConfiguration(input: unknown): RemoteTrackGateConfiguration | null {
  if (!isRecord(input) || !hasExactKeys(input, ['version', 'gates', 'rolloutChannels']) || input.version !== 1 || !isRecord(input.gates)) return null
  const rawGates = input.gates
  const gateKeys = Object.keys(CONFIG_KEYS) as Array<keyof RemoteTrackFeatureGates>
  if (!hasExactKeys(rawGates, gateKeys) || gateKeys.some((key) => typeof rawGates[key] !== 'boolean')) return null
  const gates = Object.fromEntries(gateKeys.map((key) => [key, rawGates[key]])) as unknown as RemoteTrackFeatureGates
  if (validateRemoteTrackFeatureGates(gates).length > 0 || !Array.isArray(input.rolloutChannels)) return null
  const rolloutChannels = parseRemoteTrackRolloutChannels(JSON.stringify(input.rolloutChannels))
  if (!rolloutChannels) return null
  return { version: 1, gates, rolloutChannels }
}

/** Persists the full operator config atomically and refuses semantic enablement until shadow evidence passes. */
export function applyRemoteTrackGateConfiguration(db: AppDatabase, input: unknown): RemoteTrackGateConfiguration {
  const configuration = parseRemoteTrackGateConfiguration(input)
  if (!configuration) throw new Error('REMOTE_TRACK_GATE_CONFIGURATION_INVALID')
  if (configuration.gates.semanticContinuation) {
    const report = readRemoteTrackShadowGateReport(db)
    if (!report.ready) throw new Error(`REMOTE_TRACK_FEATURE_GATE_INVALID:semantic-shadow-evidence-required:${report.blockers.join(',')}`)
  }

  const values = [
    ...Object.entries(configuration.gates).map(([name, enabled]) => [CONFIG_KEYS[name as keyof RemoteTrackFeatureGates], String(enabled)] as const),
    [REMOTE_TRACK_ROLLOUT_CHANNELS_CONFIG_KEY, JSON.stringify(configuration.rolloutChannels)] as const
  ]
  const conn = getDbConnection(db)
  runInTransaction(conn, () => {
    const readCreatedAt = conn.prepare('SELECT created_at FROM configs WHERE key=?')
    const write = conn.prepare(`INSERT INTO configs(key,value,created_at,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    const now = Date.now()
    for (const [key, value] of values) {
      const existing = readCreatedAt.get(key) as { created_at: number } | undefined
      write.run(key, value, existing?.created_at ?? now, now)
    }
  })
  db.save()
  return configuration
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

export function readRemoteTrackFeatureGates(db: AppDatabase, channel?: RemoteTrackChannel): RemoteTrackFeatureGates {
  const values = Object.fromEntries(Object.entries(CONFIG_KEYS).map(([name, key]) => [name, getConfigValue(db, key) === 'true'])) as unknown as RemoteTrackFeatureGates
  const errors = validateRemoteTrackFeatureGates(values)
  if (errors.length) throw new Error(`REMOTE_TRACK_FEATURE_GATE_INVALID:${errors.join(',')}`)
  if (channel) {
    const rolloutChannels = parseRemoteTrackRolloutChannels(getConfigValue(db, REMOTE_TRACK_ROLLOUT_CHANNELS_CONFIG_KEY))
    if (!rolloutChannels) throw new Error('REMOTE_TRACK_FEATURE_GATE_INVALID:rollout-channel-scope-invalid')
    if (!rolloutChannels.includes(channel)) {
      return { persist: values.persist, shadowAttribution: false, execution: false, clarification: false,
        recovery: false, scopedModelInput: false, confirmationLink: false, semanticContinuation: false }
    }
  }
  if (values.semanticContinuation) {
    const report = readRemoteTrackShadowGateReport(db)
    if (!report.ready) throw new Error(`REMOTE_TRACK_FEATURE_GATE_INVALID:semantic-shadow-evidence-required:${report.blockers.join(',')}`)
  }
  return values
}
