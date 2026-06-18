import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppConfig } from '../../../shared/domainTypes'
import {
  addNewServiceDraft,
  initLlmServiceTabState,
  removeServiceDraft,
  toggleActiveService,
  toggleCardExpanded,
  updateServiceDraft,
  type LlmServiceTabState
} from './llmServiceDrafts'
import { getEnabledModelIds } from '../../../shared/llmModelConfig'

export function useLlmServiceDrafts(open: boolean, cfg: AppConfig | null, enabledModelIds: string[] = []) {
  const [state, setState] = useState<LlmServiceTabState>({ drafts: {}, activeIds: [], order: [] })
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})

  useEffect(() => {
    if (open && cfg) {
      const ids = cfg.activeLlmServiceIds?.length
        ? cfg.activeLlmServiceIds
        : cfg.activeLlmServiceId
          ? [cfg.activeLlmServiceId]
          : []
      const modelIds = enabledModelIds.length ? enabledModelIds : getEnabledModelIds(cfg.models ?? [])
      setState(initLlmServiceTabState(cfg.llmServices ?? [], ids, modelIds))
    }
  }, [open, cfg, enabledModelIds])

  const scrollToCard = useCallback((serviceId: string) => {
    requestAnimationFrame(() => {
      cardRefs.current[serviceId]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }, [])

  const toggleActive = useCallback((serviceId: string): 'needModels' | null => {
    let issue: 'needModels' | null = null
    setState((s) => {
      const result = toggleActiveService(s, serviceId)
      if ('error' in result) {
        issue = result.error
        return s
      }
      return result
    })
    return issue
  }, [])

  const toggleExpanded = useCallback((serviceId: string) => {
    setState((s) => toggleCardExpanded(s, serviceId))
  }, [])

  const addService = useCallback(
    (modelIds: string[]) => {
      setState((s) => {
        const result = addNewServiceDraft(s, modelIds)
        if ('error' in result) return s
        scrollToCard(result.order[result.order.length - 1]!)
        return result
      })
    },
    [scrollToCard]
  )

  const removeService = useCallback(
    (serviceId: string): string | null => {
      let err: string | null = null
      setState((s) => {
        const result = removeServiceDraft(s, serviceId)
        if ('error' in result) {
          err = result.error
          return s
        }
        scrollToCard(result.activeIds[0] ?? result.order[0] ?? '')
        return result
      })
      return err
    },
    [scrollToCard]
  )

  const patchDraft = useCallback(
    (serviceId: string, patch: Parameters<typeof updateServiceDraft>[2]) => {
      setState((s) => updateServiceDraft(s, serviceId, patch))
    },
    []
  )

  const resetFromConfig = useCallback(
    (config: AppConfig) => {
      const ids = config.activeLlmServiceIds?.length
        ? config.activeLlmServiceIds
        : config.activeLlmServiceId
          ? [config.activeLlmServiceId]
          : []
      setState(initLlmServiceTabState(config.llmServices ?? [], ids, getEnabledModelIds(config.models ?? [])))
    },
    []
  )

  return {
    state,
    cardRefs,
    toggleActive,
    toggleExpanded,
    addService,
    removeService,
    patchDraft,
    resetFromConfig
  }
}

export type { LlmServiceTabState, LlmServiceDraft } from './llmServiceDrafts'
export {
  validateLlmServiceDrafts,
  formatLlmServiceValidationError,
  buildLlmServicesSavePayload,
  buildServiceSummary,
  setAllSupportedModels,
  MAX_LLM_SERVICES
} from './llmServiceDrafts'
