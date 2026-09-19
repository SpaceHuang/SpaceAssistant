import { useState } from 'react'
import { Popover } from 'antd'
import { ChevronDown } from 'lucide-react'
import type { AgentReasoningEffort } from '../../../shared/agent/invocation'
import { THINKING_EFFORT_LEVELS } from '../../../shared/thinkingEffort'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  /** 当前生效档位（会话覆盖或全局默认） */
  value: AgentReasoningEffort
  /** 是否存在会话级覆盖（决定展示「默认（中）」还是显式档位） */
  overridden: boolean
  /** 全局默认档位（「默认（中）」括注） */
  globalEffort: AgentReasoningEffort
  disabled?: boolean
  /** 禁用原因（当前会话模型不支持 Thinking） */
  disabledReason?: string
  /** null = 清除覆盖（回到继承全局） */
  onSelect: (effort: AgentReasoningEffort | null) => void
}

/** 会话级 Thinking 强度入口（需求 §5.2）：composer footer 左段、模型 chip 之后的 5 项选择器。 */
export function ComposerThinkingPicker({ value, overridden, globalEffort, disabled, disabledReason, onSelect }: Props) {
  const { t } = useTypedTranslation('chat')
  const [open, setOpen] = useState(false)

  const effortLabel = (effort: AgentReasoningEffort): string => t(`composer.thinking.${effort}`)
  const label = overridden
    ? effortLabel(value)
    : t('composer.thinking.inheritWithGlobal', { effort: effortLabel(globalEffort) })

  const items: Array<{ key: string; label: string; select: () => void }> = [
    { key: 'inherit', label: t('composer.thinking.inherit'), select: () => onSelect(null) },
    ...THINKING_EFFORT_LEVELS.map((level) => ({
      key: level,
      label: effortLabel(level),
      select: () => onSelect(level)
    }))
  ]

  const content = (
    <ul className="composer-thinking-picker__list" role="menu">
      {items.map((item) => (
        <li key={item.key}>
          <button
            type="button"
            role="menuitem"
            className={[
              'composer-thinking-picker__item',
              (item.key === 'inherit' ? !overridden : item.key === value) ? 'composer-thinking-picker__item--active' : ''
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => {
              item.select()
              setOpen(false)
            }}
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  )

  return (
    <Popover
      open={disabled ? false : open}
      onOpenChange={setOpen}
      trigger="click"
      placement="topLeft"
      classNames={{ root: 'composer-thinking-picker-popover' }}
      content={content}
    >
      <button
        type="button"
        className={[
          'composer-model-chip',
          'composer-model-chip--button',
          'composer-thinking-chip',
          open ? 'composer-model-chip--open' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={disabled && disabledReason ? disabledReason : t('composer.thinking.label')}
      >
        <span className="composer-model-chip__label">{label}</span>
        <ChevronDown size={12} strokeWidth={2} className="composer-model-chip__chevron" aria-hidden />
      </button>
    </Popover>
  )
}
