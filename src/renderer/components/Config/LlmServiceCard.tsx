import { useState } from 'react'
import { App, Button, Checkbox, Input, Select, Space } from 'antd'
import type { ModelEntry } from '../../../shared/domainTypes'
import { ConfigModelOptionContent } from './ConfigModelOption'
import type { LlmServiceDraft } from './llmServiceDrafts'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import './llmServiceCard.css'

function ChevronIcon({ down }: { down: boolean }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" style={{ transform: down ? 'rotate(180deg)' : undefined }}>
      <path fill="currentColor" d="M12 10.828 6.343 5.172 5 6.515l7 7 7-7-1.343-1.343z" />
    </svg>
  )
}

function DeleteIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
      <path
        fill="currentColor"
        d="M14.28 2a2 2 0 0 1 1.897 1.368L16.72 5H20a1 1 0 1 1 0 2l-.003.071-.867 12.143A3 3 0 0 1 16.138 22H7.862a3 3 0 0 1-2.992-2.786L4.003 7.07A1.01 1.01 0 0 1 4 7a1 1 0 0 1 0-2h3.28l.543-1.632A2 2 0 0 1 9.721 2zm3.717 5H6.003l.862 12.071a1 1 0 0 0 .997.929h8.276a1 1 0 0 0 .997-.929zM10 10a1 1 0 0 1 .993.883L11 11v5a1 1 0 0 1-1.993.117L9 16v-5a1 1 0 0 1 1-1m4 0a1 1 0 0 1 1 1v5a1 1 0 1 1-2 0v-5a1 1 0 0 1 1-1m.28-6H9.72l-.333 1h5.226z"
      />
    </svg>
  )
}

function buildServiceSummary(draft: LlmServiceDraft, t: ReturnType<typeof useTypedTranslation<'config'>>['t']): string {
  const keyLabel =
    draft.apiKeyPresent || draft.apiKeyDraft.trim() ? t('llmService.keyConfigured') : t('llmService.keyNotConfigured')
  const modelPart = t('llmService.supportedModelsCount', { count: draft.supportedModelIds.length })
  if (draft.baseUrl.trim()) {
    return `${draft.baseUrl.trim()} · ${keyLabel} · ${modelPart}`
  }
  return `${t('llmService.officialDefault')} · ${keyLabel} · ${modelPart}`
}

type Props = {
  draft: LlmServiceDraft
  isActive: boolean
  modelsMissing?: boolean
  canDelete: boolean
  enabledModels: ModelEntry[]
  cardRef: (el: HTMLDivElement | null) => void
  onToggleActive: () => void
  onToggleExpand: () => void
  onDelete: () => void
  onPatch: (patch: Partial<Pick<LlmServiceDraft, 'name' | 'baseUrl' | 'apiKeyDraft' | 'supportedModelIds'>>) => void
}

export function LlmServiceCard({
  draft,
  isActive,
  modelsMissing = false,
  canDelete,
  enabledModels,
  cardRef,
  onToggleActive,
  onToggleExpand,
  onDelete,
  onPatch
}: Props) {
  const { message } = App.useApp()
  const { t } = useTypedTranslation('config')
  const { t: tCommon } = useTypedTranslation('common')
  const [testing, setTesting] = useState(false)
  const expanded = draft.expanded

  const testConnection = async () => {
    if (draft.supportedModelIds.length === 0) {
      message.warning(t('llmService.testConnectionNeedModels'))
      return
    }
    setTesting(true)
    try {
      const r = await window.api.configTestConnection({
        serviceId: draft.id,
        apiKey: draft.apiKeyDraft.trim() || undefined,
        baseUrl: draft.baseUrl,
        supportedModelIds: draft.supportedModelIds
      })
      if (r.success) message.success(t('messages.connectionSuccess'))
      else message.error(r.error ?? t('messages.connectionFailed'))
    } finally {
      setTesting(false)
    }
  }

  const displayTitle = draft.name.trim() || (draft.isNew ? t('llmService.newService') : t('llmService.unnamedService'))
  const selectableIds = enabledModels.map((m) => m.id)

  const selectAll = () => onPatch({ supportedModelIds: [...selectableIds] })
  const clearAll = () => onPatch({ supportedModelIds: [] })

  return (
    <div
      ref={cardRef}
      className={[
        'llm-service-card',
        isActive ? 'llm-service-card--active' : '',
        draft.isNew ? 'llm-service-card--new' : '',
        modelsMissing ? 'llm-service-card--models-missing' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="llm-service-card-header">
        <Checkbox checked={isActive} onChange={onToggleActive}>
          {t('llmService.active')}
        </Checkbox>
        {expanded ? (
          <Input
            className="llm-service-card-title"
            value={draft.name}
            onChange={(e) => onPatch({ name: e.target.value })}
            placeholder={t('llmService.serviceNamePlaceholder')}
            maxLength={32}
          />
        ) : (
          <span className="llm-service-card-title">{displayTitle}</span>
        )}
        <Button
          type="text"
          size="small"
          icon={<ChevronIcon down={expanded} />}
          onClick={onToggleExpand}
          title={expanded ? t('llmService.collapse') : t('llmService.expand')}
          aria-label={expanded ? t('llmService.collapseAria') : t('llmService.expandAria')}
        />
        <Button
          type="text"
          size="small"
          danger
          icon={<DeleteIcon />}
          disabled={!canDelete}
          title={canDelete ? tCommon('delete') : t('llmService.keepAtLeastOne')}
          aria-label={canDelete ? t('llmService.deleteAria') : t('llmService.keepAtLeastOneAria')}
          onClick={onDelete}
        />
      </div>
      {!expanded && <div className="llm-service-card-summary">{buildServiceSummary(draft, t)}</div>}
      {expanded && (
        <div className="llm-service-card-body">
          <div className="llm-service-supported-models">
            <div className="llm-service-supported-models__header">
              <span className="llm-service-field-label">{t('llmService.supportedModelsLabel')}</span>
              <Space size={4}>
                <Button size="small" type="link" onClick={selectAll}>
                  {t('llmService.selectAllModels')}
                </Button>
                <Button size="small" type="link" onClick={clearAll}>
                  {t('llmService.clearAllModels')}
                </Button>
              </Space>
            </div>
            <Select
              mode="multiple"
              style={{ width: '100%' }}
              placeholder={t('llmService.supportedModelsPlaceholder')}
              value={draft.supportedModelIds}
              onChange={(ids) => onPatch({ supportedModelIds: ids })}
              options={enabledModels.map((m) => ({ value: m.id, label: m.name }))}
              optionRender={(opt) => {
                const m = enabledModels.find((x) => x.id === opt.value)
                return m ? <ConfigModelOptionContent m={m} compact /> : opt.label
              }}
              maxTagCount="responsive"
              status={modelsMissing ? 'error' : undefined}
            />
            {modelsMissing ? (
              <p className="llm-service-supported-models__hint">{t('llmService.supportedModelsRequired')}</p>
            ) : null}
          </div>
          <div className="llm-service-key-field">
            <div className="llm-service-field-label">{t('llmService.apiKeyLabel')}</div>
            <Input.Password
              placeholder="sk-ant-..."
              autoComplete="off"
              value={draft.apiKeyDraft}
              onChange={(e) => onPatch({ apiKeyDraft: e.target.value })}
            />
            <div className="llm-service-key-hint">
              {draft.apiKeyPresent || draft.apiKeyDraft.trim()
                ? t('llmService.apiKeyHintConfigured')
                : t('llmService.apiKeyHintEmpty')}
            </div>
          </div>
          <div className="llm-service-url-field">
            <div className="llm-service-field-label">{t('llmService.baseUrlLabel')}</div>
            <Input
              placeholder={t('llmService.baseUrlPlaceholder')}
              value={draft.baseUrl}
              onChange={(e) => onPatch({ baseUrl: e.target.value })}
            />
          </div>
          <div className="llm-service-test-row">
            <Button onClick={() => void testConnection()} loading={testing}>
              {t('llmService.testConnection')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
