import { useRef, useState } from 'react'
import { App, Button } from 'antd'
import type { ModelEntry } from '../../../shared/domainTypes'
import { mergeFetchedModels, type FetchServiceModelsError } from '../../../shared/llmModelConfig'
import { LlmServiceCard } from './LlmServiceCard'
import { MAX_LLM_SERVICES } from './llmServiceDrafts'
import type { useLlmServiceDrafts } from './useLlmServiceDrafts'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import './llmServiceCard.css'

type DraftsApi = ReturnType<typeof useLlmServiceDrafts>

type Props = {
  draftsApi: DraftsApi
  enabledModels: ModelEntry[]
  models: ModelEntry[]
  onModelsChange: (models: ModelEntry[]) => void
}

export function LlmServiceTab({ draftsApi, enabledModels, models, onModelsChange }: Props) {
  const { message, modal } = App.useApp()
  const { t } = useTypedTranslation('config')
  const { t: tCommon } = useTypedTranslation('common')
  const { state, cardRefs, toggleActive, toggleExpanded, addService, removeService, patchDraft } = draftsApi
  const [fetchingServiceId, setFetchingServiceId] = useState<string | null>(null)
  // 拉取是异步的，合并时必须读最新目录（并发拉取 / 拉取期间手动添加模型）——P0-4
  const modelsRef = useRef(models)
  modelsRef.current = models

  const FETCH_ERROR_KEYS = {
    unauthorized: 'llmService.fetchModels.errorUnauthorized',
    'not-found': 'llmService.fetchModels.errorNotFound',
    timeout: 'llmService.fetchModels.errorTimeout',
    network: 'llmService.fetchModels.errorNetwork',
    'invalid-response': 'llmService.fetchModels.errorInvalidResponse',
    'no-api-key': 'llmService.fetchModels.errorNoApiKey',
    'invalid-base-url': 'llmService.fetchModels.errorInvalidBaseUrl'
  } as const satisfies Record<FetchServiceModelsError, string>

  const handleAdd = () => {
    if (state.order.length >= MAX_LLM_SERVICES) {
      message.warning(t('llmService.maxServices', { max: MAX_LLM_SERVICES }))
      return
    }
    addService(enabledModels.map((m) => m.id))
  }

  const handleDelete = (serviceId: string) => {
    modal.confirm({
      title: t('llmService.deleteTitle'),
      content: t('llmService.deleteContent'),
      okText: tCommon('delete'),
      okType: 'danger',
      cancelText: tCommon('cancel'),
      onOk: () => {
        const err = removeService(serviceId)
        if (err) message.warning(err)
      }
    })
  }

  const handleFetchModels = async (serviceId: string) => {
    const draft = state.drafts[serviceId]
    if (!draft) return
    setFetchingServiceId(serviceId)
    try {
      const r = await window.api.llmFetchServiceModels({
        serviceId: draft.id,
        apiKey: draft.apiKeyDraft.trim() || undefined,
        baseUrl: draft.baseUrl
      })
      if (!r.ok) {
        message.error(t(FETCH_ERROR_KEYS[r.error]))
        return
      }
      // 空结果视为「不确定」：不动勾选与拉取缓存，避免网关异常返回空时清空用户勾选（§6.1）
      if (r.models.length === 0) {
        message.info(t('llmService.fetchModels.empty'))
        return
      }
      const currentModels = modelsRef.current
      const merge = mergeFetchedModels(currentModels, r.models, draft.supportedModelIds)
      if (merge.catalogChanged) onModelsChange(merge.models)
      if (r.truncated) {
        // 结果不完整（页数/总量超限）：只合并新增并补勾选，不替换、不更新拉取缓存、不做失效判定（P0-3）
        const union = [...new Set([...draft.supportedModelIds, ...merge.supportedModelIds])]
        patchDraft(serviceId, { supportedModelIds: union })
        message.warning(t('llmService.fetchModels.incomplete', { total: r.models.length, added: merge.addedNames.length }))
        return
      }
      // 合并进全局目录 + 替换服务勾选（§6.4，应用前自动清空）；结果仍走草稿，点保存才落库
      patchDraft(serviceId, {
        supportedModelIds: merge.supportedModelIds,
        fetchedModelIds: r.models.map((m) => m.id),
        fetchedAt: Date.now()
      })
      if (merge.removedIds.length > 0) {
        message.success(
          t('llmService.fetchModels.successRemoved', {
            total: r.models.length,
            added: merge.addedNames.length,
            removed: merge.removedIds.length
          })
        )
      } else {
        message.success(t('llmService.fetchModels.success', { total: r.models.length, added: merge.addedNames.length }))
      }
    } catch {
      message.error(t('llmService.fetchModels.errorNetwork'))
    } finally {
      setFetchingServiceId(null)
    }
  }

  return (
    <>
      <div className="llm-service-list">
        {state.order.map((id) => {
          const draft = state.drafts[id]
          if (!draft) return null
          return (
            <LlmServiceCard
              key={id}
              draft={draft}
              isActive={state.activeIds.includes(id)}
              modelsMissing={draft.supportedModelIds.length === 0}
              canDelete={state.order.length > 1}
              enabledModels={enabledModels}
              cardRef={(el) => {
                cardRefs.current[id] = el
              }}
              onToggleActive={() => {
                const err = toggleActive(id)
                if (err === 'needModels') {
                  const name = draft.name.trim() || t('llmService.unnamedService')
                  message.warning(t('llmService.activateNeedModels', { name }))
                }
              }}
              onToggleExpand={() => toggleExpanded(id)}
              onDelete={() => handleDelete(id)}
              onPatch={(patch) => patchDraft(id, patch)}
              onFetchModels={() => void handleFetchModels(id)}
              fetchingModels={fetchingServiceId === id}
            />
          )
        })}
      </div>
      <Button
        type="dashed"
        block
        className="llm-service-add-btn"
        disabled={state.order.length >= MAX_LLM_SERVICES}
        onClick={handleAdd}
      >
        {t('llmService.addService')}
      </Button>
    </>
  )
}
