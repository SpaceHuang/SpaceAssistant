import { useState } from 'react'
import { App, Button, Checkbox, Input, InputNumber, Popover } from 'antd'
import type { ModelEntry } from '../../../shared/domainTypes'
import { buildCustomModelEntry } from '../../../shared/llmModelConfig'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

function AddIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      <path fill="currentColor" d="M11 20a1 1 0 1 0 2 0v-7h7a1 1 0 1 0 0-2h-7V4a1 1 0 0 0-2 0v7H4a1 1 0 0 0 0 2h7z" />
    </svg>
  )
}

type Props = {
  models: ModelEntry[]
  onAdd: (model: ModelEntry) => void
}

export function ManualModelPopover({ models, onAdd }: Props) {
  const { message } = App.useApp()
  const { t } = useTypedTranslation('config')
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [maxContext, setMaxContext] = useState<number | null>(null)
  const [maxTokens, setMaxTokens] = useState<number | null>(null)
  const [isFast, setIsFast] = useState(false)
  const [isVision, setIsVision] = useState(false)
  const [supportsThinking, setSupportsThinking] = useState(true)

  const add = () => {
    const normalizedName = name.trim()
    if (!normalizedName) return
    if (models.some((model) => model.name === normalizedName)) {
      message.warning(t('models.nameExists'))
      return
    }
    onAdd(buildCustomModelEntry({
      id: crypto.randomUUID(),
      name: normalizedName,
      isFast,
      isVision,
      ...(maxContext !== null ? { maximumContext: maxContext } : {}),
      ...(maxTokens !== null ? { maxTokens } : {}),
      ...(supportsThinking ? {} : { supportsThinking: false })
    }))
    setName('')
    setMaxContext(null)
    setMaxTokens(null)
    setIsFast(false)
    setIsVision(false)
    setSupportsThinking(true)
    setOpen(false)
  }

  const content = (
    <div className="config-add-model-popover">
      <div className="config-add-model-field">
        <span className="config-add-model-label">{t('models.add.nameLabel')}</span>
        <Input placeholder={t('models.add.namePlaceholder')} value={name} onChange={(event) => setName(event.target.value)} onPressEnter={add} autoFocus />
      </div>
      <div className="config-add-model-row">
        <div className="config-add-model-field">
          <span className="config-add-model-label">{t('models.add.maxContextLabel')}</span>
          <InputNumber placeholder={t('models.add.maxContextPlaceholder')} value={maxContext} onChange={(value) => setMaxContext(typeof value === 'number' ? value : null)} min={1} style={{ width: '100%' }} />
        </div>
        <div className="config-add-model-field">
          <span className="config-add-model-label">{t('models.add.maxOutputLabel')}</span>
          <InputNumber placeholder={t('models.add.maxOutputPlaceholder')} value={maxTokens} onChange={(value) => setMaxTokens(typeof value === 'number' ? value : null)} min={1} style={{ width: '100%' }} />
        </div>
      </div>
      <p className="config-add-model-hint">{t('models.add.hint')}</p>
      <div className="config-add-model-tags">
        <Checkbox checked={isFast} onChange={(event) => setIsFast(event.target.checked)}>{t('models.add.fastLabel')}</Checkbox>
        <Checkbox checked={isVision} onChange={(event) => setIsVision(event.target.checked)}>{t('models.add.visionLabel')}</Checkbox>
        <Checkbox checked={supportsThinking} onChange={(event) => setSupportsThinking(event.target.checked)}>{t('models.add.supportsThinking')}</Checkbox>
      </div>
      <Button type="primary" size="small" block onClick={add} disabled={!name.trim()}>{t('models.add.submit')}</Button>
    </div>
  )

  return (
    <Popover classNames={{ root: 'config-settings-popover' }} content={content} open={open} onOpenChange={setOpen} trigger="click" placement="bottomRight">
      <Button size="small" type="link" aria-label={t('llmService.addManualModel')}>
        <AddIcon /> {t('llmService.addManualModel')}
      </Button>
    </Popover>
  )
}
