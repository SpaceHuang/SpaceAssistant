import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppConfig } from '../../../shared/domainTypes'
import {
  addNewServiceDraft,
  initLlmServiceTabState,
  removeServiceDraft,
  setActiveService,
  toggleCardExpanded,
  updateServiceDraft,
  type LlmServiceTabState
} from './llmServiceDrafts'

export function useLlmServiceDrafts(open: boolean, cfg: AppConfig | null) {
  const [state, setState] = useState<LlmServiceTabState>({ drafts: {}, activeId: '', order: [] })
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})

  useEffect(() => {
    if (open && cfg) {
      setState(initLlmServiceTabState(cfg.llmServices ?? [], cfg.activeLlmServiceId ?? ''))
    }
  }, [open, cfg])

  const scrollToCard = useCallback((serviceId: string) => {
    requestAnimationFrame(() => {
      cardRefs.current[serviceId]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }, [])

  const selectActive = useCallback(
    (serviceId: string) => {
      setState((s) => {
        const next = setActiveService(s, serviceId)
        return next
      })
      scrollToCard(serviceId)
    },
    [scrollToCard]
  )

  const toggleExpanded = useCallback((serviceId: string) => {
    setState((s) => toggleCardExpanded(s, serviceId))
  }, [])

  const addService = useCallback(() => {
    setState((s) => {
      const result = addNewServiceDraft(s)
      if ('error' in result) return s
      scrollToCard(result.order[result.order.length - 1]!)
      return result
    })
  }, [scrollToCard])

  const removeService = useCallback(
    (serviceId: string): string | null => {
      let err: string | null = null
      setState((s) => {
        const result = removeServiceDraft(s, serviceId)
        if ('error' in result) {
          err = result.error
          return s
        }
        if (serviceId === s.activeId) {
          scrollToCard(result.activeId)
        }
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

  const resetFromConfig = useCallback((config: AppConfig) => {
    setState(initLlmServiceTabState(config.llmServices ?? [], config.activeLlmServiceId ?? ''))
  }, [])

  return {
    state,
    cardRefs,
    selectActive,
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
  buildLlmServicesSavePayload,
  buildServiceSummary,
  MAX_LLM_SERVICES
} from './llmServiceDrafts'
