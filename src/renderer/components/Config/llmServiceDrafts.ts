import type { LlmServiceProfile } from '../../../shared/domainTypes'

export const MAX_LLM_SERVICES = 10

export type LlmServiceDraft = {
  id: string
  name: string
  baseUrl: string
  apiKeyDraft: string
  apiKeyPresent: boolean
  expanded: boolean
  isNew?: boolean
}

export type LlmServiceTabState = {
  drafts: Record<string, LlmServiceDraft>
  activeId: string
  order: string[]
}

export function initLlmServiceTabState(
  services: LlmServiceProfile[],
  activeLlmServiceId: string
): LlmServiceTabState {
  const order = services.map((s) => s.id)
  const activeId = order.includes(activeLlmServiceId) ? activeLlmServiceId : order[0] ?? ''
  const drafts: Record<string, LlmServiceDraft> = {}
  for (const s of services) {
    drafts[s.id] = {
      id: s.id,
      name: s.name,
      baseUrl: s.baseUrl,
      apiKeyDraft: '',
      apiKeyPresent: s.apiKeyPresent,
      expanded: s.id === activeId
    }
  }
  return { drafts, activeId, order }
}

export function buildServiceSummary(draft: LlmServiceDraft): string {
  const keyLabel = draft.apiKeyPresent || draft.apiKeyDraft.trim() ? 'Key 已配置' : '未配置 Key'
  if (draft.baseUrl.trim()) {
    return `${draft.baseUrl.trim()} · ${keyLabel}`
  }
  return `官方默认 · ${keyLabel}`
}

export function setActiveService(
  state: LlmServiceTabState,
  nextActiveId: string
): LlmServiceTabState {
  const prevActiveId = state.activeId
  const drafts = { ...state.drafts }
  for (const id of Object.keys(drafts)) {
    const d = drafts[id]!
    if (id === nextActiveId) {
      drafts[id] = { ...d, expanded: true }
    } else if (id === prevActiveId) {
      drafts[id] = { ...d, expanded: false }
    }
  }
  return { ...state, activeId: nextActiveId, drafts }
}

export function toggleCardExpanded(state: LlmServiceTabState, serviceId: string): LlmServiceTabState {
  if (serviceId === state.activeId) return state
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

export function addNewServiceDraft(state: LlmServiceTabState): LlmServiceTabState | { error: string } {
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
    expanded: true,
    isNew: true
  }
  return {
    drafts: { ...state.drafts, [id]: draft },
    activeId: state.activeId,
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
  let activeId = state.activeId
  let expandedSet = false
  if (serviceId === state.activeId) {
    activeId = order[0]!
    if (drafts[activeId]) {
      drafts[activeId] = { ...drafts[activeId]!, expanded: true }
      expandedSet = true
    }
  }
  if (!expandedSet && drafts[activeId] && serviceId !== state.activeId) {
    /* keep expansions */
  }
  return { drafts, activeId, order }
}

export function updateServiceDraft(
  state: LlmServiceTabState,
  serviceId: string,
  patch: Partial<Pick<LlmServiceDraft, 'name' | 'baseUrl' | 'apiKeyDraft'>>
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

export function validateLlmServiceDrafts(state: LlmServiceTabState): string | null {
  if (state.order.length === 0) return '至少保留一套大模型服务'
  if (!state.activeId || !state.drafts[state.activeId]) return '请选择当前使用的大模型服务'

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
  }
  return null
}

export function buildLlmServicesSavePayload(state: LlmServiceTabState): {
  llmServices: LlmServiceProfile[]
  activeLlmServiceId: string
  llmServiceKeys: Record<string, string>
} {
  const llmServices: LlmServiceProfile[] = state.order.map((id) => {
    const d = state.drafts[id]!
    return {
      id: d.id,
      name: d.name.trim(),
      baseUrl: d.baseUrl.trim(),
      apiKeyPresent: d.apiKeyPresent || Boolean(d.apiKeyDraft.trim())
    }
  })
  const llmServiceKeys: Record<string, string> = {}
  for (const id of state.order) {
    const d = state.drafts[id]!
    if (d.apiKeyDraft.trim()) {
      llmServiceKeys[id] = d.apiKeyDraft.trim()
    }
  }
  return { llmServices, activeLlmServiceId: state.activeId, llmServiceKeys }
}
