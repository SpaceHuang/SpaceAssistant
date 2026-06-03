import { App, Button } from 'antd'
import { LlmServiceCard } from './LlmServiceCard'
import { MAX_LLM_SERVICES } from './llmServiceDrafts'
import type { useLlmServiceDrafts } from './useLlmServiceDrafts'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import './llmServiceCard.css'

type DraftsApi = ReturnType<typeof useLlmServiceDrafts>

type Props = {
  draftsApi: DraftsApi
}

export function LlmServiceTab({ draftsApi }: Props) {
  const { message, modal } = App.useApp()
  const { t } = useTypedTranslation('config')
  const { t: tCommon } = useTypedTranslation('common')
  const { state, cardRefs, selectActive, toggleExpanded, addService, removeService, patchDraft } = draftsApi

  const handleAdd = () => {
    if (state.order.length >= MAX_LLM_SERVICES) {
      message.warning(t('llmService.maxServices', { max: MAX_LLM_SERVICES }))
      return
    }
    addService()
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
              isActive={state.activeId === id}
              canDelete={state.order.length > 1}
              cardRef={(el) => {
                cardRefs.current[id] = el
              }}
              onSelectActive={() => selectActive(id)}
              onToggleExpand={() => toggleExpanded(id)}
              onDelete={() => handleDelete(id)}
              onPatch={(patch) => patchDraft(id, patch)}
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
