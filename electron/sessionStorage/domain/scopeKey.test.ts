import { describe, expect, it } from 'vitest'
import { CHAT_BODY_PROJECTION_SPEC_VERSION, encodeProjectionScopeKey, projectionScopeSpecVersion, PROJECTION_SCOPE_KINDS, type ProjectionScopeDescriptor } from './scopeKey'
import { PROJECTION_SPECS } from './projectionSpec'

describe('projection scope key codec', () => {
  it('stays aligned with the registered ProjectionSpec kinds', () => {
    expect([...PROJECTION_SCOPE_KINDS].sort()).toEqual(Object.keys(PROJECTION_SPECS).sort())
  })

  it('uses a fresh durable scope for the corrected chat body reducer', () => {
    expect(projectionScopeSpecVersion(encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: CHAT_BODY_PROJECTION_SPEC_VERSION }))).toBe(2)
  })

  it('encodes only the view kind/spec and its declared track/window dimensions', () => {
    const base: ProjectionScopeDescriptor = { scope: 'acceptedContextV1', specVersion: 1, trackId: 'track-a', window: { fromSequence: 10, toSequence: 20 } }
    expect(encodeProjectionScopeKey(base)).toBe(encodeProjectionScopeKey({ ...base, window: { toSequence: 20, fromSequence: 10 } }))
    expect(encodeProjectionScopeKey(base)).not.toBe(encodeProjectionScopeKey({ ...base, trackId: 'track-b' }))
    expect(encodeProjectionScopeKey(base)).not.toBe(encodeProjectionScopeKey({ ...base, window: { fromSequence: 11, toSequence: 20 } }))
    expect(encodeProjectionScopeKey(base)).not.toBe(encodeProjectionScopeKey({ ...base, specVersion: 2 }))
  })

  it('does not encode request selection parameters or source watermarks', () => {
    const base: ProjectionScopeDescriptor = { scope: 'searchCorpusV1', specVersion: 1 }
    const selected = { ...base, limit: 5, beforeSequence: 40, historyWatermark: 'watermark-a' } as ProjectionScopeDescriptor
    expect(encodeProjectionScopeKey(selected)).toBe(encodeProjectionScopeKey(base))
  })

  it('rejects invalid scope identity and malformed track windows', () => {
    expect(() => encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 0 })).toThrow('INVALID_PROJECTION_SCOPE_SPEC_VERSION')
    expect(() => encodeProjectionScopeKey({ scope: 'acceptedContextV1', specVersion: 1, trackId: ' ' })).toThrow('INVALID_PROJECTION_SCOPE_TRACK_ID')
    expect(() => encodeProjectionScopeKey({ scope: 'acceptedContextV1', specVersion: 1, window: { fromSequence: 8, toSequence: 7 } })).toThrow('INVALID_PROJECTION_SCOPE_WINDOW')
  })

  it('decodes only a valid registered scope key when resolving its spec version', () => {
    expect(projectionScopeSpecVersion(encodeProjectionScopeKey({ scope: 'chatMessageV1', specVersion: 3 }))).toBe(3)
    expect(projectionScopeSpecVersion('chatMessageV1')).toBeNull()
    expect(projectionScopeSpecVersion('session-projection:%5B%22unknown%22%2C1%2Cnull%2Cnull%5D')).toBeNull()
  })
})
