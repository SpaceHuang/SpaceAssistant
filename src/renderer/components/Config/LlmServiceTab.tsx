import { App, Button } from 'antd'
import { LlmServiceCard } from './LlmServiceCard'
import { MAX_LLM_SERVICES } from './llmServiceDrafts'
import type { useLlmServiceDrafts } from './useLlmServiceDrafts'
import './llmServiceCard.css'

type DraftsApi = ReturnType<typeof useLlmServiceDrafts>

type Props = {
  draftsApi: DraftsApi
}

export function LlmServiceTab({ draftsApi }: Props) {
  const { message, modal } = App.useApp()
  const { state, cardRefs, selectActive, toggleExpanded, addService, removeService, patchDraft } = draftsApi

  const handleAdd = () => {
    if (state.order.length >= MAX_LLM_SERVICES) {
      message.warning(`最多配置 ${MAX_LLM_SERVICES} 套大模型服务`)
      return
    }
    addService()
  }

  const handleDelete = (serviceId: string) => {
    modal.confirm({
      title: '删除大模型服务',
      content: '确定删除该服务？删除后不可恢复。',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
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
        添加服务
      </Button>
    </>
  )
}
