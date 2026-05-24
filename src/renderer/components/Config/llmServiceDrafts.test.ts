import { describe, expect, it } from 'vitest'
import {
  addNewServiceDraft,
  buildLlmServicesSavePayload,
  buildServiceSummary,
  initLlmServiceTabState,
  removeServiceDraft,
  setActiveService,
  updateServiceDraft,
  validateLlmServiceDrafts
} from './llmServiceDrafts'

describe('llmServiceDrafts', () => {
  const services = [
    { id: 'a', name: 'Service A', baseUrl: 'https://a.com', apiKeyPresent: true },
    { id: 'b', name: 'Service B', baseUrl: '', apiKeyPresent: false }
  ]

  it('initializes with active card expanded', () => {
    const state = initLlmServiceTabState(services, 'a')
    expect(state.drafts.a!.expanded).toBe(true)
    expect(state.drafts.b!.expanded).toBe(false)
  })

  it('preserves apiKeyDraft when switching active service', () => {
    let state = initLlmServiceTabState(services, 'a')
    state = updateServiceDraft(state, 'a', { apiKeyDraft: 'sk-draft-a' })
    state = setActiveService(state, 'b')
    state = setActiveService(state, 'a')
    expect(state.drafts.a!.apiKeyDraft).toBe('sk-draft-a')
  })

  it('selects first service when deleting active', () => {
    let state = initLlmServiceTabState(services, 'b')
    const result = removeServiceDraft(state, 'b')
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.activeId).toBe('a')
    expect(result.drafts.a!.expanded).toBe(true)
    expect(result.order).toEqual(['a'])
  })

  it('builds save payload with keys only for non-empty drafts', () => {
    let state = initLlmServiceTabState(services, 'a')
    state = updateServiceDraft(state, 'b', { apiKeyDraft: 'sk-new-b' })
    const payload = buildLlmServicesSavePayload(state)
    expect(payload.llmServiceKeys).toEqual({ b: 'sk-new-b' })
    expect(payload.activeLlmServiceId).toBe('a')
    expect(payload.llmServices).toHaveLength(2)
  })

  it('validates new service requires api key', () => {
    let added = addNewServiceDraft(initLlmServiceTabState(services, 'a'))
    if ('error' in added) throw new Error('expected state')
    const newId = added.order[added.order.length - 1]!
    added = updateServiceDraft(added, newId, { name: 'Brand New' })
    const err = validateLlmServiceDrafts(added)
    expect(err).toMatch(/须填写 API Key/)
  })

  it('buildServiceSummary shows base url or official default', () => {
    expect(buildServiceSummary({ id: '1', name: 'X', baseUrl: 'https://x.com', apiKeyDraft: '', apiKeyPresent: true, expanded: false })).toContain('https://x.com')
    expect(buildServiceSummary({ id: '1', name: 'X', baseUrl: '', apiKeyDraft: '', apiKeyPresent: false, expanded: false })).toContain('官方默认')
  })
})
