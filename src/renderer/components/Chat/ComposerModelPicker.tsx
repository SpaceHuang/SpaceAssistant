import { useMemo, useState } from 'react'
import { Popover } from 'antd'
import { ChevronDown } from 'lucide-react'
import type { AppConfig } from '../../../shared/domainTypes'
import { ConfigModelBadges } from '../Config/ConfigModelOption'
import { listChatModelOptions } from '../../services/sessionModelBinding'
import type { ChatModelOption } from '../../../shared/llmModelConfig'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  cfg: AppConfig
  displayName: string
  unavailable?: boolean
  onSelect: (option: ChatModelOption) => void
}

export function ComposerModelPicker({ cfg, displayName, unavailable, onSelect }: Props) {
  const { t } = useTypedTranslation('chat')
  const [open, setOpen] = useState(false)
  const options = useMemo(() => listChatModelOptions(cfg), [cfg])

  const content = (
    <div className="composer-model-picker">
      {options.length === 0 ? (
        <div className="composer-model-picker__empty">{t('modelPicker.empty')}</div>
      ) : (
        <ul className="composer-model-picker__list">
          {options.map((opt) => (
            <li key={`${opt.serviceId}:${opt.modelId}`}>
              <button
                type="button"
                className="composer-model-picker__item"
                onClick={() => {
                  onSelect(opt)
                  setOpen(false)
                }}
              >
                <span className="composer-model-picker__service">{opt.serviceName}</span>
                <div className="composer-model-picker__detail">
                  <span className="composer-model-picker__model">{opt.modelName}</span>
                  <ConfigModelBadges m={opt.model} />
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="topLeft"
      overlayClassName="composer-model-picker-popover"
      content={content}
    >
      <button
        type="button"
        className={[
          'composer-model-chip',
          'composer-model-chip--button',
          open ? 'composer-model-chip--open' : '',
          unavailable ? 'composer-model-chip--warn' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('modelPicker.selectModelAria', { name: displayName })}
        title={unavailable ? t('modelPicker.unavailableHint') : t('modelPicker.switchModel')}
      >
        <span className="composer-model-chip__label">{displayName}</span>
        <ChevronDown size={12} strokeWidth={2} className="composer-model-chip__chevron" aria-hidden />
      </button>
    </Popover>
  )
}
