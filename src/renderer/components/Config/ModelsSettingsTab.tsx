import { useState } from 'react'
import { App, Button, Checkbox, Form, Input, InputNumber, Popover, Select, Space, Switch } from 'antd'
import type { ModelEntry } from '../../../shared/domainTypes'
import { DEFAULT_MODEL_MAX_CONTEXT, DEFAULT_MODEL_MAX_TOKENS } from '../../../shared/domainTypes'
import { ConfigModelOptionContent, ConfigModelSelectValue } from './ConfigModelOption'
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

function ModelSelect({ value, onChange }: { value: ModelEntry[]; onChange: (v: ModelEntry[]) => void }) {
  const { t } = useTypedTranslation('config')
  const selectable = value.filter((m) => m.enabled)
  const defaultModel = selectable.find((m) => m.isDefault) ?? selectable[0]

  const handleChange = (id: string) => {
    onChange(value.map((m) => ({ ...m, isDefault: m.id === id })))
  }

  if (selectable.length === 0) {
    return <div className="config-model-select-empty">{t('models.noModelsAvailable')}</div>
  }

  return (
    <Select
      className="config-model-select"
      style={{ width: '100%' }}
      value={defaultModel?.id}
      onChange={handleChange}
      classNames={configModalModelSelectPopupClassNames}
      options={selectable.map((m) => ({ value: m.id, label: m.name }))}
      optionRender={(opt) => {
        const m = selectable.find((x) => x.id === opt.value)
        return m ? <ConfigModelOptionContent m={m} /> : opt.label
      }}
      labelRender={(item) => {
        const m = selectable.find((x) => x.id === item.value)
        return m ? <ConfigModelSelectValue m={m} /> : item.label
      }}
    />
  )
}

type DraftsApi = ReturnType<typeof useLlmServiceDrafts>

type Props = {
  draftsApi: DraftsApi
  models: ModelEntry[]
  onModelsChange: (models: ModelEntry[]) => void
  onResetModels: () => void
}

export function ModelsSettingsTab({ draftsApi, models, onModelsChange, onResetModels }: Props) {
  const { message } = App.useApp()
  const { t } = useTypedTranslation('config')
  const [addOpen, setAddOpen] = useState(false)
  const [addName, setAddName] = useState('')
  const [addMaxCtx, setAddMaxCtx] = useState<number | null>(null)
  const [addMaxTokens, setAddMaxTokens] = useState<number | null>(null)
  const [addFast, setAddFast] = useState(false)

  const addModel = () => {
    const name = addName.trim()
    if (!name) return
    if (models.some((m) => m.name === name)) {
      message.warning(t('models.nameExists'))
      return
    }
    const id = crypto.randomUUID()
    const maximumContext = addMaxCtx ?? DEFAULT_ADD_MODEL_MAX_CONTEXT
    const maxTokens = addMaxTokens ?? DEFAULT_ADD_MODEL_MAX_TOKENS
    const entry: ModelEntry = { id, name, maximumContext, maxTokens, isDefault: false, isFast: addFast, enabled: true }
    const updated = [...models, entry]
    if (updated.length === 1) {
      entry.isDefault = true
    }
    if (updated.length > 0 && !updated.some((m) => m.isDefault)) {
      updated[0]!.isDefault = true
    }
    onModelsChange(updated)
    setAddName('')
    setAddMaxCtx(null)
    setAddMaxTokens(null)
    setAddFast(false)
    setAddOpen(false)
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
      <Checkbox checked={addFast} onChange={(e) => setAddFast(e.target.checked)}>
        {t('models.add.fastLabel')}
      </Checkbox>
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
          <LlmServiceTab draftsApi={draftsApi} />
        </div>
      </section>

      <section className="config-models-section" aria-labelledby="config-models-default-title">
        <h2 id="config-models-default-title" className="config-models-section__title">
          {t('models.defaults.title')}
        </h2>
        <p className="config-models-section__intro">{t('models.defaults.intro')}</p>

        <div className="config-models-field-stack">
          <div className="config-field config-model-field">
            <div className="config-field-row">
              <span className="config-field__label">{t('models.defaults.defaultModel')}</span>
              <Space size={6} className="config-model-field__actions">
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
              </Space>
            </div>
            <div className="config-field__control">
              <ModelSelect value={models} onChange={onModelsChange} />
            </div>
          </div>

          <div className="config-field config-models-thinking-field">
            <div className="config-field-row">
              <span className="config-field__label">{t('models.defaults.thinkingLabel')}</span>
              <Form.Item name="thinkingEnabled" valuePropName="checked" noStyle preserve>
                <Switch aria-label={t('models.defaults.thinkingAria')} />
              </Form.Item>
            </div>
            <p className="config-field__hint">{t('models.defaults.thinkingHint')}</p>
          </div>
        </div>
      </section>
    </div>
  )
}
