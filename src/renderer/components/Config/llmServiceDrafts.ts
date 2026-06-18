import type { LlmServiceProfile, ModelEntry } from '../../../shared/domainTypes'

export const MAX_LLM_SERVICES = 10

export type LlmServiceDraft = {
  id: string
  name: string
  baseUrl: string
  apiKeyDraft: string
  apiKeyPresent: boolean
  supportedModelIds: string[]
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
      expanded: fallbackActive.includes(s.id)
    }
  }
  return { drafts, activeIds: fallbackActive, order }
}

export function buildServiceSummary(
  draft: LlmServiceDraft,
  supportedCount?: number
): string {
  const keyLabel = draft.apiKeyPresent || draft.apiKeyDraft.trim() ? 'Key 已配置' : '未配置 Key'
  const modelPart =
    supportedCount !== undefined ? ` · 已支持 ${supportedCount} 个模型` : ` · 已支持 ${draft.supportedModelIds.length} 个模型`
  if (draft.baseUrl.trim()) {
    return `${draft.baseUrl.trim()} · ${keyLabel}${modelPart}`
  }
  return `官方默认 · ${keyLabel}${modelPart}`
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
      name: draft.name.trim() || '未命名服务'
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
    return { error: `最多配置 ${MAX_LLM_SERVICES} 套大模型服务` }
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
    return { error: '至少保留一套服务' }
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
  patch: Partial<Pick<LlmServiceDraft, 'name' | 'baseUrl' | 'apiKeyDraft' | 'supportedModelIds'>>
): LlmServiceTabState {
  const d = state.drafts[serviceId]
  if (!d) return state
  return {
    ...state,
    drafts: {
      ...state.drafts,
      [serviceId]: { ...d, ...patch }
    }
  }
}

export function setAllSupportedModels(state: LlmServiceTabState, serviceId: string, modelIds: string[]): LlmServiceTabState {
  return updateServiceDraft(state, serviceId, { supportedModelIds: [...modelIds] })
}

export function formatLlmServiceValidationError(
  err: string,
  t: (key: 'llmService.validationNeedModels', params: { name: string }) => string
): string {
  const match = err.match(/^服务「(.+)」须至少支持一个模型$/)
  if (match) {
    return t('llmService.validationNeedModels', { name: match[1]! })
  }
  return err
}

export function validateLlmServiceDrafts(state: LlmServiceTabState): string | null {
  if (state.order.length === 0) return '至少保留一套大模型服务'
  if (state.activeIds.length === 0) return '至少选择一个当前使用的服务'

  const names = new Set<string>()
  for (const id of state.order) {
    const d = state.drafts[id]
    if (!d) continue
    const name = d.name.trim()
    if (!name) return '服务名称不能为空'
    if (name.length > 32) return '服务名称不能超过 32 个字符'
    const key = name.toLowerCase()
    if (names.has(key)) return `服务名称「${name}」重复`
    names.add(key)
    if (d.isNew && !d.apiKeyDraft.trim()) return `新建服务「${name || '新服务'}」须填写 API Key`
    if (d.supportedModelIds.length === 0) {
      return `服务「${name || '未命名服务'}」须至少支持一个模型`
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
      supportedModelIds: [...d.supportedModelIds]
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
