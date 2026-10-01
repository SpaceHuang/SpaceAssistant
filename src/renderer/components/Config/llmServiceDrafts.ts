import type { LlmServiceProfile, ModelEntry } from '../../../shared/domainTypes'
import { runtimeText } from '../../i18n/runtimeText'

export const MAX_LLM_SERVICES = 10

export type LlmServiceDraft = {
  id: string
  name: string
  baseUrl: string
  apiKeyDraft: string
  apiKeyPresent: boolean
  supportedModelIds: string[]
  /** 最近一次拉取成功的服务模型 id 缓存（=ModelEntry.name），随保存落库 */
  fetchedModelIds?: string[]
  fetchedAt?: number
  expanded: boolean
  isNew?: boolean
}

export type LlmServiceTabState = {
  drafts: Record<string, LlmServiceDraft>
  activeIds: string[]
  order: string[]
}

export function initLlmServiceTabState(
  services: LlmServiceProfile[],
  activeLlmServiceIds: string[],
  enabledModelIds: string[] = []
): LlmServiceTabState {
  const order = services.map((s) => s.id)
  const activeIds = activeLlmServiceIds.filter((id) => order.includes(id))
  const fallbackActive = activeIds.length > 0 ? activeIds : order[0] ? [order[0]] : []
  const drafts: Record<string, LlmServiceDraft> = {}
  for (const s of services) {
    const supported =
      s.supportedModelIds && s.supportedModelIds.length > 0
        ? s.supportedModelIds
        : [...enabledModelIds]
    drafts[s.id] = {
      id: s.id,
      name: s.name,
      baseUrl: s.baseUrl,
      apiKeyDraft: '',
      apiKeyPresent: s.apiKeyPresent,
      supportedModelIds: supported,
      fetchedModelIds: s.fetchedModelIds ? [...s.fetchedModelIds] : undefined,
      fetchedAt: s.fetchedAt,
      expanded: fallbackActive.includes(s.id)
    }
  }
  return { drafts, activeIds: fallbackActive, order }
}

export function buildServiceSummary(
  draft: LlmServiceDraft,
  supportedCount?: number
): string {
  const keyLabel = draft.apiKeyPresent || draft.apiKeyDraft.trim()
    ? runtimeText('config.llmService.keyConfigured')
    : runtimeText('config.llmService.keyNotConfigured')
  const modelPart =
    runtimeText('config.llmService.supportedModels', {
      count: supportedCount !== undefined ? supportedCount : draft.supportedModelIds.length
    })
  if (draft.baseUrl.trim()) {
    return `${draft.baseUrl.trim()} · ${keyLabel} · ${modelPart}`
  }
  return `${runtimeText('config.llmService.officialDefault')} · ${keyLabel} · ${modelPart}`
}

export function toggleActiveService(
  state: LlmServiceTabState,
  serviceId: string
): LlmServiceTabState | { error: 'needModels'; name: string } {
  const isActive = state.activeIds.includes(serviceId)
  const draft = state.drafts[serviceId]
  if (!isActive && draft && draft.supportedModelIds.length === 0) {
    return {
      error: 'needModels',
      name: draft.name.trim() || runtimeText('config.llmService.unnamed')
    }
  }

  let nextActive = isActive ? state.activeIds.filter((id) => id !== serviceId) : [...state.activeIds, serviceId]
  if (nextActive.length === 0) nextActive = [serviceId]

  const drafts = { ...state.drafts }
  const d = drafts[serviceId]
  if (d && !isActive) {
    drafts[serviceId] = { ...d, expanded: true }
  }
  return { ...state, activeIds: nextActive, drafts }
}

export function toggleCardExpanded(state: LlmServiceTabState, serviceId: string): LlmServiceTabState {
  const d = state.drafts[serviceId]
  if (!d) return state
  return {
    ...state,
    drafts: {
      ...state.drafts,
      [serviceId]: { ...d, expanded: !d.expanded }
    }
  }
}

export function addNewServiceDraft(
  state: LlmServiceTabState,
  enabledModelIds: string[]
): LlmServiceTabState | { error: string } {
  if (state.order.length >= MAX_LLM_SERVICES) {
    return { error: runtimeText('config.llmService.maxServices', { count: MAX_LLM_SERVICES }) }
  }
  const id = crypto.randomUUID()
  const draft: LlmServiceDraft = {
    id,
    name: '',
    baseUrl: '',
    apiKeyDraft: '',
    apiKeyPresent: false,
    supportedModelIds: [...enabledModelIds],
    expanded: true,
    isNew: true
  }
  return {
    drafts: { ...state.drafts, [id]: draft },
    activeIds: state.activeIds,
    order: [...state.order, id]
  }
}

export function removeServiceDraft(
  state: LlmServiceTabState,
  serviceId: string
): LlmServiceTabState | { error: string } {
  if (state.order.length <= 1) {
    return { error: runtimeText('config.llmService.keepOne') }
  }
  const order = state.order.filter((id) => id !== serviceId)
  const drafts = { ...state.drafts }
  delete drafts[serviceId]
  let activeIds = state.activeIds.filter((id) => id !== serviceId)
  if (activeIds.length === 0) activeIds = [order[0]!]
  if (drafts[activeIds[0]!]) {
    drafts[activeIds[0]!] = { ...drafts[activeIds[0]!]!, expanded: true }
  }
  return { drafts, activeIds, order }
}

export function updateServiceDraft(
  state: LlmServiceTabState,
  serviceId: string,
  patch: Partial<Pick<LlmServiceDraft, 'name' | 'baseUrl' | 'apiKeyDraft' | 'supportedModelIds' | 'fetchedModelIds' | 'fetchedAt'>>
): LlmServiceTabState {
  const d = state.drafts[serviceId]
  if (!d) return state
  const next = { ...d, ...patch }
  // baseUrl 变更意味着服务指向改变，旧拉取结论不再可信（P1-7）
  if (patch.baseUrl !== undefined && patch.baseUrl.trim() !== d.baseUrl.trim()) {
    next.fetchedModelIds = undefined
    next.fetchedAt = undefined
  }
  return {
    ...state,
    drafts: {
      ...state.drafts,
      [serviceId]: next
    }
  }
}

export function setAllSupportedModels(state: LlmServiceTabState, serviceId: string, modelIds: string[]): LlmServiceTabState {
  return updateServiceDraft(state, serviceId, { supportedModelIds: [...modelIds] })
}

export function validateLlmServiceDrafts(state: LlmServiceTabState): string | null {
  if (state.order.length === 0) return runtimeText('config.llmService.needOneModelService')
  if (state.activeIds.length === 0) return runtimeText('config.llmService.selectActiveService')

  const names = new Set<string>()
  for (const id of state.order) {
    const d = state.drafts[id]
    if (!d) continue
    const name = d.name.trim()
    if (!name) return runtimeText('config.llmService.nameRequired')
    if (name.length > 32) return runtimeText('config.llmService.nameTooLong')
    const key = name.toLowerCase()
    if (names.has(key)) return runtimeText('config.llmService.duplicateName', { name })
    names.add(key)
    if (d.isNew && !d.apiKeyDraft.trim()) {
      return runtimeText('config.llmService.apiKeyRequired', {
        name: name || runtimeText('config.llmService.newService')
      })
    }
    if (d.supportedModelIds.length === 0) {
      return runtimeText('config.llmService.modelRequired', {
        name: name || runtimeText('config.llmService.unnamed')
      })
    }
  }
  return null
}

export function buildLlmServicesSavePayload(state: LlmServiceTabState): {
  llmServices: LlmServiceProfile[]
  activeLlmServiceIds: string[]
  activeLlmServiceId: string
  llmServiceKeys: Record<string, string>
} {
  const llmServices: LlmServiceProfile[] = state.order.map((id) => {
    const d = state.drafts[id]!
    return {
      id: d.id,
      name: d.name.trim(),
      baseUrl: d.baseUrl.trim(),
      apiKeyPresent: d.apiKeyPresent || Boolean(d.apiKeyDraft.trim()),
      supportedModelIds: [...d.supportedModelIds],
      fetchedModelIds: d.fetchedModelIds ? [...d.fetchedModelIds] : undefined,
      fetchedAt: d.fetchedAt
    }
  })
  const llmServiceKeys: Record<string, string> = {}
  for (const id of state.order) {
    const d = state.drafts[id]!
    if (d.apiKeyDraft.trim()) {
      llmServiceKeys[id] = d.apiKeyDraft.trim()
    }
  }
  return {
    llmServices,
    activeLlmServiceIds: [...state.activeIds],
    activeLlmServiceId: state.activeIds[0] ?? '',
    llmServiceKeys
  }
}

export function isBuiltinModel(model: ModelEntry, models: ModelEntry[]): boolean {
  const defaults = new Set(models.map((m) => m.name))
  return defaults.has(model.name)
}
