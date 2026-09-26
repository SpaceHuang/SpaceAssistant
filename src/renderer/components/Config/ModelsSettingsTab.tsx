import { useMemo } from 'react'
import { Form, Select } from 'antd'
import type { LlmServiceProfile, ModelEntry } from '../../../shared/domainTypes'
import {
  filterPreferredModelCandidates,
  getAvailableModels,
  isPreferredModelAvailable
} from '../../../shared/llmModelConfig'
import { THINKING_EFFORT_LEVELS } from '../../../shared/thinkingEffort'
import {
  ConfigModelOptionContent,
  ConfigModelSelectValuePreferred,
  ConfigModelVisionBadge
} from './ConfigModelOption'
import { configModalModelSelectPopupClassNames } from './configModalUi'
import { LlmServiceTab } from './LlmServiceTab'
import type { useLlmServiceDrafts } from './useLlmServiceDrafts'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type PreferredSelectProps = {
  label: string
  value: string
  options: ModelEntry[]
  onChange: (id: string) => void
  unavailable?: boolean
}

function PreferredModelSelect({ label, value, options, onChange, unavailable }: PreferredSelectProps) {
  const { t } = useTypedTranslation('config')

  return (
    <div className="config-models-preferred-field">
      <span className="config-models-preferred-field__label">{label}</span>
      {options.length === 0 ? (
        <div className="config-model-select-empty">{t('models.noModelsAvailable')}</div>
      ) : (
        <Select
          className="config-model-select config-model-select--preferred"
          value={value || undefined}
          onChange={onChange}
          classNames={configModalModelSelectPopupClassNames}
          options={options.map((m) => ({ value: m.id, label: m.name }))}
          optionRender={(opt) => {
            const m = options.find((x) => x.id === opt.value)
            return m ? <ConfigModelOptionContent m={m} /> : opt.label
          }}
          labelRender={(item) => {
            const m = options.find((x) => x.id === item.value)
            return m ? <ConfigModelSelectValuePreferred m={m} /> : item.label
          }}
        />
      )}
      {unavailable ? (
        <p className="config-models-preferred-field__hint config-field__hint--warn">
          {t('models.preferredUnavailableHint')}
        </p>
      ) : null}
    </div>
  )
}

type DraftsApi = ReturnType<typeof useLlmServiceDrafts>

type Props = {
  draftsApi: DraftsApi
  models: ModelEntry[]
  onModelsChange: (models: ModelEntry[]) => void
  preferredLanguageModelId: string
  preferredFastLanguageModelId: string
  preferredVisionModelId: string
  onPreferredChange: (patch: {
    preferredLanguageModelId?: string
    preferredFastLanguageModelId?: string
    preferredVisionModelId?: string
  }) => void
}

export function ModelsSettingsTab({
  draftsApi,
  models,
  onModelsChange,
  preferredLanguageModelId,
  preferredFastLanguageModelId,
  preferredVisionModelId,
  onPreferredChange
}: Props) {
  const { t } = useTypedTranslation('config')

  const enabledModels = useMemo(() => models.map((m) => ({ ...m, enabled: true })), [models])

  const llmServices: LlmServiceProfile[] = useMemo(
    () =>
      draftsApi.state.order.map((id) => {
        const d = draftsApi.state.drafts[id]!
        return {
          id: d.id,
          name: d.name,
          baseUrl: d.baseUrl,
          apiKeyPresent: d.apiKeyPresent,
          supportedModelIds: d.supportedModelIds
        }
      }),
    [draftsApi.state]
  )

  const availablePool = useMemo(
    () => getAvailableModels(models, llmServices, draftsApi.state.activeIds),
    [models, llmServices, draftsApi.state.activeIds]
  )

  const languageOptions = availablePool
  const fastOptions = filterPreferredModelCandidates('fast', availablePool)
  const visionOptions = filterPreferredModelCandidates('vision', availablePool)

  return (
    <div className="config-models-settings">
      <section className="config-models-section" aria-labelledby="config-models-api-title">
        <h2 id="config-models-api-title" className="config-models-section__title">
          {t('models.apiServices.title')}
        </h2>
        <p className="config-models-section__intro">{t('models.apiServices.intro')}</p>
        <div className="config-models-section__content">
          <LlmServiceTab draftsApi={draftsApi} enabledModels={enabledModels} models={models} onModelsChange={onModelsChange} />
        </div>
      </section>

      <section className="config-models-section" aria-labelledby="config-models-default-title">
        <h2 id="config-models-default-title" className="config-models-section__title">
          {t('models.defaults.title')}
        </h2>
        <p className="config-models-section__intro">{t('models.defaults.intro')}</p>

        <div className="config-models-field-stack">
          <div className="config-models-panel config-models-panel--preferred">
            <div className="config-models-panel__head">
              <span className="config-models-panel__title">{t('models.defaults.preferredGroup')}</span>
            </div>
            <div className="config-models-preferred-layout">
              <div className="config-models-preferred-group">
                <span className="config-models-preferred-group__title">{t('models.defaults.languageGroup')}</span>
                <div className="config-models-preferred-group__fields config-models-preferred-group__fields--pair">
                  <PreferredModelSelect
                    label={t('models.defaults.preferredLanguageShort')}
                    value={preferredLanguageModelId}
                    options={languageOptions}
                    onChange={(id) => onPreferredChange({ preferredLanguageModelId: id })}
                    unavailable={!isPreferredModelAvailable(preferredLanguageModelId, availablePool, 'language')}
                  />
                  <PreferredModelSelect
                    label={t('models.defaults.preferredFastShort')}
                    value={preferredFastLanguageModelId}
                    options={fastOptions}
                    onChange={(id) => onPreferredChange({ preferredFastLanguageModelId: id })}
                    unavailable={!isPreferredModelAvailable(preferredFastLanguageModelId, availablePool, 'fast')}
                  />
                </div>
              </div>
              <div className="config-models-preferred-group">
                <span className="config-models-preferred-group__title">{t('models.defaults.visionGroup')}</span>
                <div className="config-models-preferred-group__fields config-models-preferred-group__fields--pair">
                  <PreferredModelSelect
                    label={t('models.defaults.preferredVisionShort')}
                    value={preferredVisionModelId}
                    options={visionOptions}
                    onChange={(id) => onPreferredChange({ preferredVisionModelId: id })}
                    unavailable={!isPreferredModelAvailable(preferredVisionModelId, availablePool, 'vision')}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="config-models-panel config-models-panel--inline">
            <div className="config-field-row config-models-thinking-row">
              <div className="config-models-thinking-row__text">
                <span className="config-field__label">{t('models.defaults.effortLabel')}</span>
                <p className="config-field__hint">{t('models.defaults.effortHint')}</p>
              </div>
              <Form.Item name="thinkingEffort" noStyle>
                <Select
                  className="config-models-effort-select"
                  aria-label={t('models.defaults.effortAria')}
                  options={THINKING_EFFORT_LEVELS.map((level) => ({
                    value: level,
                    label: t(`models.effort.${level}`)
                  }))}
                />
              </Form.Item>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
