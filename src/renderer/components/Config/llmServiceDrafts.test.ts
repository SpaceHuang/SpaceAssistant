import { describe, expect, it } from 'vitest'
import {
  addNewServiceDraft,
  buildLlmServicesSavePayload,
  initLlmServiceTabState,
  removeServiceDraft,
  toggleActiveService,
  updateServiceDraft,
  validateLlmServiceDrafts
} from './llmServiceDrafts'

describe('llmServiceDrafts', () => {
  const services = [
    {
      id: 'a',
      name: 'Service A',
      baseUrl: 'https://a.com',
      apiKeyPresent: true,
      supportedModelIds: ['m1', 'm2']
    },
    { id: 'b', name: 'Service B', baseUrl: '', apiKeyPresent: false, supportedModelIds: ['m1'] }
  ]
  const enabledIds = ['m1', 'm2']

  it('initializes with active cards expanded', () => {
    const state = initLlmServiceTabState(services, ['a'], enabledIds)
    expect(state.drafts.a!.expanded).toBe(true)
    expect(state.activeIds).toEqual(['a'])
  })

  it('allows multiple active services', () => {
    let state = initLlmServiceTabState(services, ['a'], enabledIds)
    const result = toggleActiveService(state, 'b')
    expect('error' in result).toBe(false)
    if ('error' in result) return
    state = result
    expect(state.activeIds).toEqual(['a', 'b'])
  })

  it('cannot deactivate last active service', () => {
    let state = initLlmServiceTabState(services, ['a'], enabledIds)
    const result = toggleActiveService(state, 'a')
    expect('error' in result).toBe(false)
    if ('error' in result) return
    state = result
    expect(state.activeIds).toEqual(['a'])
  })

  it('selects first service when deleting last active', () => {
    let state = initLlmServiceTabState(services, ['b'], enabledIds)
    const result = removeServiceDraft(state, 'b')
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.activeIds).toEqual(['a'])
  })

  it('builds save payload with activeLlmServiceIds', () => {
    const state = initLlmServiceTabState(services, ['a', 'b'], enabledIds)
    const payload = buildLlmServicesSavePayload(state)
    expect(payload.activeLlmServiceIds).toEqual(['a', 'b'])
    expect(payload.llmServices[0]!.supportedModelIds).toEqual(['m1', 'm2'])
  })

  it('new service defaults to all enabled models', () => {
    let state = initLlmServiceTabState(services, ['a'], enabledIds)
    const added = addNewServiceDraft(state, enabledIds)
    if ('error' in added) throw new Error('expected state')
    const newId = added.order[added.order.length - 1]!
    expect(added.drafts[newId]!.supportedModelIds).toEqual(enabledIds)
  })

  it('validates every service requires supported models', () => {
    let state = initLlmServiceTabState(services, ['a'], enabledIds)
    state = updateServiceDraft(state, 'a', { supportedModelIds: [] })
    expect(validateLlmServiceDrafts(state)).toMatch(/须至少支持一个模型/)
  })

  it('validates inactive service with empty supported models', () => {
    let state = initLlmServiceTabState(services, ['a'], enabledIds)
    state = updateServiceDraft(state, 'b', { supportedModelIds: [] })
    expect(validateLlmServiceDrafts(state)).toMatch(/Service B/)
  })

  it('blocks activating service without supported models', () => {
    let state = initLlmServiceTabState(services, ['a'], enabledIds)
    state = updateServiceDraft(state, 'b', { supportedModelIds: [] })
    const result = toggleActiveService(state, 'b')
    expect(result).toEqual({ error: 'needModels', name: 'Service B' })
  })
})
