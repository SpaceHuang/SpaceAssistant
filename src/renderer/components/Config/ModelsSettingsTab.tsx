import { useMemo, useState } from 'react'
import { App, Button, Checkbox, Form, Input, InputNumber, Popover, Select, Switch } from 'antd'
import type { LlmServiceProfile, ModelEntry } from '../../../shared/domainTypes'
import {
  DEFAULT_MODEL_MAX_CONTEXT,
  DEFAULT_MODEL_MAX_TOKENS,
  DEFAULT_MODELS
} from '../../../shared/domainTypes'
import {
  getAvailableModels,
  getDefaultPreferredModelIds,
  isPreferredModelAvailable,
  sortModelsFastFirst
} from '../../../shared/llmModelConfig'
import {
  ConfigModelFastBadge,
  ConfigModelOptionContent,
  ConfigModelSelectValuePreferred,
  ConfigModelVisionBadge,
  formatNumber
} from './ConfigModelOption'
import { configModalModelSelectPopupClassNames } from './configModalUi'
import { LlmServiceTab } from './LlmServiceTab'
import type { useLlmServiceDrafts } from './useLlmServiceDrafts'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

const DEFAULT_ADD_MODEL_MAX_CONTEXT = DEFAULT_MODEL_MAX_CONTEXT
const DEFAULT_ADD_MODEL_MAX_TOKENS = DEFAULT_MODEL_MAX_TOKENS

function AddIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      <path fill="currentColor" d="M11 20a1 1 0 1 0 2 0v-7h7a1 1 0 1 0 0-2h-7V4a1 1 0 1 0-2 0v7H4a1 1 0 1 0 0 2h7z" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M2 12.08c-.006-.862.91-1.356 1.618-.975l.095.058 2.678 1.804c.972.655.377 2.143-.734 2.007l-.117-.02-1.063-.234a8.002 8.002 0 0 0 14.804.605 1 1 0 0 1 1.82.828c-1.987 4.37-6.896 6.793-11.687 5.509A10.003 10.003 0 0 1 2 12.08m.903-4.228C4.89 3.482 9.799 1.06 14.59 2.343a10.002 10.002 0 0 1 7.414 9.581c.007.863-.91 1.358-1.617.976l-.096-.058-2.678-1.804c-.972-.655-.377-2.143.734-2.007l.117.02 1.063.234A8.002 8.002 0 0 0 4.723 8.68a1 1 0 1 1-1.82-.828"
      />
    </svg>
  )
}

function DeleteIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M14.28 2a2 2 0 0 1 1.897 1.368L16.72 5H20a1 1 0 1 1 0 2l-.003.071-.867 12.143A3 3 0 0 1 16.138 22H7.862a3 3 0 0 1-2.992-2.786L4.003 7.07A1.01 1.01 0 0 1 4 7a1 1 0 0 1 0-2h3.28l.543-1.632A2 2 0 0 1 9.721 2zm3.717 5H6.003l.862 12.071a1 1 0 0 0 .997.929h8.276a1 1 0 0 0 .997-.929zM10 10a1 1 0 0 1 .993.883L11 11v5a1 1 0 0 1-1.993.117L9 16v-5a1 1 0 0 1 1-1m4 0a1 1 0 0 1 1 1v5a1 1 0 1 1-2 0v-5a1 1 0 0 1 1-1m.28-6H9.72l-.333 1h5.226z"
      />
    </svg>
  )
}

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
  onResetModels: () => void
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
  onResetModels,
  preferredLanguageModelId,
  preferredFastLanguageModelId,
  preferredVisionModelId,
  onPreferredChange
}: Props) {
  const { message } = App.useApp()
  const { t } = useTypedTranslation('config')
  const { t: tCommon } = useTypedTranslation('common')
  const [addOpen, setAddOpen] = useState(false)
  const [addName, setAddName] = useState('')
  const [addMaxCtx, setAddMaxCtx] = useState<number | null>(null)
  const [addMaxTokens, setAddMaxTokens] = useState<number | null>(null)
  const [addFast, setAddFast] = useState(false)
  const [addVision, setAddVision] = useState(false)

  const enabledModels = useMemo(() => models.filter((m) => m.enabled), [models])
  const sortedModels = useMemo(() => sortModelsFastFirst(models), [models])
  const defaultNames = useMemo(() => new Set(DEFAULT_MODELS.map((m) => m.name)), [])

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
  const fastOptions = availablePool.filter((m) => m.isFast)
  const visionOptions = availablePool.filter((m) => m.isVision)

  const addModel = () => {
    const name = addName.trim()
    if (!name) return
    if (models.some((m) => m.name === name)) {
      message.warning(t('models.nameExists'))
      return
    }
    const id = crypto.randomUUID()
    const entry: ModelEntry = {
      id,
      name,
      maximumContext: addMaxCtx ?? DEFAULT_ADD_MODEL_MAX_CONTEXT,
      maxTokens: addMaxTokens ?? DEFAULT_ADD_MODEL_MAX_TOKENS,
      isDefault: false,
      isFast: addFast,
      isVision: addVision,
      enabled: true
    }
    onModelsChange([...models, entry])
    setAddName('')
    setAddMaxCtx(null)
    setAddMaxTokens(null)
    setAddFast(false)
    setAddVision(false)
    setAddOpen(false)
  }

  const toggleEnabled = (id: string, enabled: boolean) => {
    onModelsChange(models.map((m) => (m.id === id ? { ...m, enabled } : m)))
  }

  const removeCustomModel = (id: string) => {
    onModelsChange(models.filter((m) => m.id !== id))
  }

  const addContent = (
    <div className="config-add-model-popover">
      <div className="config-add-model-field">
        <span className="config-add-model-label">{t('models.add.nameLabel')}</span>
        <Input
          placeholder={t('models.add.namePlaceholder')}
          value={addName}
          onChange={(e) => setAddName(e.target.value)}
          onPressEnter={addModel}
          autoFocus
        />
      </div>
      <div className="config-add-model-row">
        <div className="config-add-model-field">
          <span className="config-add-model-label">{t('models.add.maxContextLabel')}</span>
          <InputNumber
            placeholder={t('models.add.maxContextPlaceholder')}
            value={addMaxCtx}
            onChange={(v) => setAddMaxCtx(typeof v === 'number' ? v : null)}
            min={1}
            style={{ width: '100%' }}
          />
        </div>
        <div className="config-add-model-field">
          <span className="config-add-model-label">{t('models.add.maxOutputLabel')}</span>
          <InputNumber
            placeholder={t('models.add.maxOutputPlaceholder')}
            value={addMaxTokens}
            onChange={(v) => setAddMaxTokens(typeof v === 'number' ? v : null)}
            min={1}
            style={{ width: '100%' }}
          />
        </div>
      </div>
      <p className="config-add-model-hint">{t('models.add.hint')}</p>
      <div className="config-add-model-tags">
        <Checkbox checked={addFast} onChange={(e) => setAddFast(e.target.checked)}>
          {t('models.add.fastLabel')}
        </Checkbox>
        <Checkbox checked={addVision} onChange={(e) => setAddVision(e.target.checked)}>
          {t('models.add.visionLabel')}
        </Checkbox>
      </div>
      <Button type="primary" size="small" block onClick={addModel} disabled={!addName.trim()}>
        {t('models.add.submit')}
      </Button>
    </div>
  )

  return (
    <div className="config-models-settings">
      <section className="config-models-section" aria-labelledby="config-models-api-title">
        <h2 id="config-models-api-title" className="config-models-section__title">
          {t('models.apiServices.title')}
        </h2>
        <p className="config-models-section__intro">{t('models.apiServices.intro')}</p>
        <div className="config-models-section__content">
          <LlmServiceTab draftsApi={draftsApi} enabledModels={enabledModels} />
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

          <div className="config-models-panel config-models-panel--catalog">
            <div className="config-models-panel__head">
              <span className="config-models-panel__title">{t('models.list.title')}</span>
              <div className="config-models-panel__actions">
                <Button
                  size="small"
                  icon={<RefreshIcon />}
                  onClick={onResetModels}
                  aria-label={t('models.defaults.resetDefaultAria')}
                  title={t('models.defaults.resetDefault')}
                />
                <Popover
                  overlayClassName="config-settings-popover"
                  content={addContent}
                  open={addOpen}
                  onOpenChange={setAddOpen}
                  trigger="click"
                  placement="bottomRight"
                >
                  <Button
                    size="small"
                    type="primary"
                    icon={<AddIcon />}
                    aria-label={t('models.defaults.addModel')}
                    title={t('models.defaults.addModel')}
                  />
                </Popover>
              </div>
            </div>
            <div className="config-models-catalog" role="list">
              <div className="config-models-catalog__head" aria-hidden="true">
                <span className="config-models-catalog__col config-models-catalog__col--toggle" />
                <span className="config-models-catalog__col config-models-catalog__col--name">
                  {t('models.list.colModel')}
                </span>
                <span className="config-models-catalog__col config-models-catalog__col--cap-fast">
                  {t('models.list.colFast')}
                </span>
                <span className="config-models-catalog__col config-models-catalog__col--cap-vision">
                  {t('models.list.colVision')}
                </span>
                <span className="config-models-catalog__col config-models-catalog__col--ctx">
                  {t('models.list.colContext')}
                </span>
                <span className="config-models-catalog__col config-models-catalog__col--out">
                  {t('models.list.colOutput')}
                </span>
                <span className="config-models-catalog__col config-models-catalog__col--action" />
              </div>
              {sortedModels.map((m) => {
                const isBuiltin = defaultNames.has(m.name)
                const disabled = !m.enabled
                return (
                  <div
                    key={m.id}
                    className={['config-models-catalog-row', disabled ? 'config-models-catalog-row--off' : '']
                      .filter(Boolean)
                      .join(' ')}
                    role="listitem"
                  >
                    <div className="config-models-catalog__col config-models-catalog__col--toggle">
                      <Switch
                        size="small"
                        checked={m.enabled}
                        onChange={(checked) => toggleEnabled(m.id, checked)}
                        aria-label={t('models.list.toggleEnable', { name: m.name })}
                      />
                    </div>
                    <div className="config-models-catalog__col config-models-catalog__col--name">
                      <span className="config-models-catalog-row__name" title={m.name}>
                        {m.name}
                      </span>
                    </div>
                    <div className="config-models-catalog__col config-models-catalog__col--cap-fast">
                      {m.isFast ? <ConfigModelFastBadge /> : null}
                    </div>
                    <div className="config-models-catalog__col config-models-catalog__col--cap-vision">
                      {m.isVision ? <ConfigModelVisionBadge /> : null}
                    </div>
                    <div className="config-models-catalog__col config-models-catalog__col--ctx">
                      <span className="config-models-catalog-row__stat">{formatNumber(m.maximumContext)}</span>
                    </div>
                    <div className="config-models-catalog__col config-models-catalog__col--out">
                      <span className="config-models-catalog-row__stat">{formatNumber(m.maxTokens)}</span>
                    </div>
                    <div className="config-models-catalog__col config-models-catalog__col--action">
                      {!isBuiltin ? (
                        <Button
                          type="text"
                          size="small"
                          className="config-models-catalog-row__delete"
                          danger
                          icon={<DeleteIcon />}
                          aria-label={tCommon('delete')}
                          onClick={() => removeCustomModel(m.id)}
                        />
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="config-models-panel config-models-panel--inline">
            <div className="config-field-row config-models-thinking-row">
              <div className="config-models-thinking-row__text">
                <span className="config-field__label">{t('models.defaults.thinkingLabel')}</span>
                <p className="config-field__hint">{t('models.defaults.thinkingHint')}</p>
              </div>
              <Form.Item name="thinkingEnabled" valuePropName="checked" noStyle preserve>
                <Switch aria-label={t('models.defaults.thinkingAria')} />
              </Form.Item>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

export { getDefaultPreferredModelIds }
