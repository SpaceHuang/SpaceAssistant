import { describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { AppConfig } from '../../../shared/domainTypes'
import { useLlmServiceDrafts } from './useLlmServiceDrafts'

function makeCfg(): AppConfig {
  return {
    llmServices: [
      { id: 'a', name: 'Service A', baseUrl: '', apiKeyPresent: true, supportedModelIds: ['m1'] }
    ],
    activeLlmServiceId: 'a',
    activeLlmServiceIds: ['a'],
    models: [
      {
        id: 'm1',
        name: 'model-1',
        maximumContext: 200000,
        maxTokens: 64000,
        isDefault: false,
        isFast: false,
        isVision: false,
        enabled: true
      }
    ]
  } as unknown as AppConfig
}

describe('useLlmServiceDrafts', () => {
  it('does not rebuild drafts when enabledModelIds change mid-session (e.g. after model fetch)', () => {
    const cfg = makeCfg()
    const { result, rerender } = renderHook(
      ({ enabledIds }: { enabledIds: string[] }) => useLlmServiceDrafts(true, cfg, enabledIds),
      { initialProps: { enabledIds: ['m1'] } }
    )
    expect(result.current.state.drafts.a!.supportedModelIds).toEqual(['m1'])

    // 用户编辑草稿（未保存）
    act(() => {
      result.current.patchDraft('a', { name: 'Edited Name', supportedModelIds: ['m1', 'm2'] })
    })
    expect(result.current.state.drafts.a!.name).toBe('Edited Name')

    // 拉取合并新增目录模型 → enabledModelIds 变化，草稿不得被重建
    rerender({ enabledIds: ['m1', 'm2', 'm3'] })
    expect(result.current.state.drafts.a!.name).toBe('Edited Name')
    expect(result.current.state.drafts.a!.supportedModelIds).toEqual(['m1', 'm2'])
  })

  it('still reinitializes when modal reopens', () => {
    const cfg = makeCfg()
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useLlmServiceDrafts(open, cfg, ['m1']),
      { initialProps: { open: true } }
    )
    act(() => {
      result.current.patchDraft('a', { name: 'Edited Name' })
    })
    rerender({ open: false })
    rerender({ open: true })
    expect(result.current.state.drafts.a!.name).toBe('Service A')
  })
})
