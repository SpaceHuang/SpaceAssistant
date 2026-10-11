import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getConfigValue, setConfigValue } from '../database'
import { applyRemoteTrackGateConfiguration, parseRemoteTrackGateConfiguration, readRemoteTrackFeatureGates, validateRemoteTrackFeatureGates, type RemoteTrackFeatureGates } from './remoteTrackFeatureGates'

const off: RemoteTrackFeatureGates = { persist: false, shadowAttribution: false, execution: false, clarification: false,
  recovery: false, scopedModelInput: false, confirmationLink: false, semanticContinuation: false }
const shadowProfile = { version: 1, gates: { ...off, persist: true, shadowAttribution: true, execution: true, recovery: true,
  scopedModelInput: true, clarification: true }, rolloutChannels: ['wechat'] }

describe('remote Track feature gates', () => {
  it('defaults every rollout gate off', () => {
    const db = createMemoryAppDb()
    try { expect(readRemoteTrackFeatureGates(db)).toEqual(off) } finally { db.close() }
  })

  it('scopes Track rollout to explicitly selected IM channels', () => {
    const db = createMemoryAppDb()
    try {
      for (const [key, value] of Object.entries({ remoteTrackPersist: 'true', remoteTrackShadowAttribution: 'true',
        remoteTrackExecution: 'true', remoteTrackRecovery: 'true', remoteTrackScopedModelInput: 'true',
        remoteTrackClarification: 'true', remoteTrackRolloutChannels: '["wechat"]' })) setConfigValue(db, key, value)

      expect(readRemoteTrackFeatureGates(db, 'wechat')).toMatchObject({ shadowAttribution: true, execution: true, clarification: true })
      expect(readRemoteTrackFeatureGates(db, 'feishu')).toEqual({ ...off, persist: true })
      setConfigValue(db, 'remoteTrackRolloutChannels', '[]')
      expect(readRemoteTrackFeatureGates(db, 'wechat')).toEqual({ ...off, persist: true })
    } finally { db.close() }
  })

  it('rejects a malformed or duplicate rollout channel scope', () => {
    const db = createMemoryAppDb()
    try {
      setConfigValue(db, 'remoteTrackRolloutChannels', '["wechat","wechat"]')
      expect(() => readRemoteTrackFeatureGates(db, 'wechat')).toThrow('REMOTE_TRACK_FEATURE_GATE_INVALID:rollout-channel-scope-invalid')
    } finally { db.close() }
  })

  it('rejects any execution or semantic gate missing its prerequisite', () => {
    expect(validateRemoteTrackFeatureGates({ ...off, execution: true })).toEqual(['persist-required', 'execution-prerequisites-required'])
    expect(validateRemoteTrackFeatureGates({ ...off, semanticContinuation: true })).toEqual([
      'semantic-continuation-requires-clarification', 'semantic-continuation-requires-shadow-observation'
    ])
    expect(validateRemoteTrackFeatureGates({ ...off, clarification: true })).toEqual(['clarification-requires-execution'])
    expect(validateRemoteTrackFeatureGates({ ...off, confirmationLink: true })).toEqual(['confirmation-link-requires-execution'])
  })

  it('accepts the complete dependency chain and rejects incomplete persisted configuration on read', () => {
    const ready: RemoteTrackFeatureGates = { ...off, persist: true, shadowAttribution: true, execution: true, recovery: true, scopedModelInput: true,
      clarification: true, semanticContinuation: true, confirmationLink: true }
    expect(validateRemoteTrackFeatureGates(ready)).toEqual([])
    const db = createMemoryAppDb()
    try {
      setConfigValue(db, 'remoteTrackExecution', 'true')
      expect(() => readRemoteTrackFeatureGates(db)).toThrow('REMOTE_TRACK_FEATURE_GATE_INVALID:persist-required,execution-prerequisites-required')
    } finally { db.close() }
  })

  it('does not enable semantic continuation without 14-day reviewed shadow evidence and measured cost', () => {
    const db = createMemoryAppDb()
    try {
      for (const [key, value] of Object.entries({ remoteTrackPersist: 'true', remoteTrackShadowAttribution: 'true',
        remoteTrackExecution: 'true', remoteTrackRecovery: 'true', remoteTrackScopedModelInput: 'true',
        remoteTrackClarification: 'true', remoteTrackSemanticContinuation: 'true' })) setConfigValue(db, key, value)
      expect(() => readRemoteTrackFeatureGates(db)).toThrow(/semantic-shadow-evidence-required/)
    } finally { db.close() }
  })

  it('parses a closed versioned operational gate configuration', () => {
    expect(parseRemoteTrackGateConfiguration(shadowProfile)).toEqual(shadowProfile)
    expect(parseRemoteTrackGateConfiguration({ ...shadowProfile, extra: true })).toBeNull()
    expect(parseRemoteTrackGateConfiguration({ ...shadowProfile, gates: { ...shadowProfile.gates, persist: 'true' } })).toBeNull()
    expect(parseRemoteTrackGateConfiguration({ ...shadowProfile, gates: { ...off, execution: true } })).toBeNull()
    expect(parseRemoteTrackGateConfiguration({ ...shadowProfile, rolloutChannels: ['wechat', 'wechat'] })).toBeNull()
    expect(parseRemoteTrackGateConfiguration({ ...shadowProfile, rolloutChannels: ['desktop'] })).toBeNull()
  })

  it('writes all operational gate flags and rollout scope in one validated update', () => {
    const db = createMemoryAppDb()
    try {
      applyRemoteTrackGateConfiguration(db, shadowProfile)
      expect(readRemoteTrackFeatureGates(db, 'wechat')).toMatchObject({ persist: true, shadowAttribution: true, execution: true,
        recovery: true, scopedModelInput: true, clarification: true, semanticContinuation: false })
      expect(readRemoteTrackFeatureGates(db, 'feishu')).toEqual({ ...off, persist: true })
      expect(getConfigValue(db, 'remoteTrackRolloutChannels')).toBe('["wechat"]')
    } finally { db.close() }
  })

  it('does not partially update config when the request is invalid or semantic evidence is not ready', () => {
    const db = createMemoryAppDb()
    try {
      setConfigValue(db, 'remoteTrackPersist', 'false')
      setConfigValue(db, 'remoteTrackRolloutChannels', '[]')
      expect(() => applyRemoteTrackGateConfiguration(db, { ...shadowProfile, gates: { ...off, execution: true } }))
        .toThrow('REMOTE_TRACK_GATE_CONFIGURATION_INVALID')
      const semanticProfile = { ...shadowProfile, gates: { ...shadowProfile.gates, semanticContinuation: true } }
      expect(() => applyRemoteTrackGateConfiguration(db, semanticProfile)).toThrow(/semantic-shadow-evidence-required/)
      expect(getConfigValue(db, 'remoteTrackPersist')).toBe('false')
      expect(getConfigValue(db, 'remoteTrackRolloutChannels')).toBe('[]')
      expect(getConfigValue(db, 'remoteTrackShadowAttribution')).toBeUndefined()
    } finally { db.close() }
  })
})
