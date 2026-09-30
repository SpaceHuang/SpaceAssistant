import { useId, useMemo, useRef, useState } from 'react'
import { Popover } from 'antd'
import { ChevronDown } from 'lucide-react'
import type { AgentReasoningEffort } from '../../../shared/agent/invocation'
import type { AppConfig } from '../../../shared/domainTypes'
import type { ChatModelOption } from '../../../shared/llmModelConfig'
import { THINKING_EFFORT_LEVELS } from '../../../shared/thinkingEffort'
import { listChatModelOptions } from '../../services/sessionModelBinding'
import { ConfigModelBadges } from '../Config/ConfigModelOption'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  cfg: AppConfig

  // ── 收起态主文案（FR3）＋ 模型分区 ──
  /** 收起态模型段：仅模型名，不含服务名前缀（FR3） */
  modelName: string
  /**
   * 收起态服务段（FR3）：仅当同名模型被 ≥2 个启用服务支持时传入（如 `Deep`），
   * 判定与 displayName（FR12）同源——直接消费 `ChatModelOption.serviceAmbiguous`。
   * 缺省 / 空 → 不渲染括号。
   */
  modelServiceName?: string
  /** hover 完整信息：`{服务名}-{模型名}`（FR5；FR12 修正后无歧义即纯模型名） */
  modelDisplayName: string
  /** 当前会话模型不可用（警告态，FR6） */
  modelUnavailable?: boolean
  onSelectModel: (option: ChatModelOption) => void

  // ── 收起态强度段（FR3）＋ 强度分区 ──
  /** 当前生效档位（会话覆盖或全局默认）：收起态强度段恒定显示（FR3） */
  effort: AgentReasoningEffort
  /** 是否存在会话级覆盖（决定浮层选中态落在覆盖档位还是默认槽） */
  effortOverridden: boolean
  /** 全局默认档位（决定浮层中哪一项带 `· 默认` 标记） */
  globalEffort: AgentReasoningEffort
  /** 当前模型不支持 Thinking：仅禁用强度分区，chip 仍可打开换模型（FR6 关键差异） */
  effortDisabled?: boolean
  /** 禁用原因文案；缺省用 `composer.prefs.effortDisabled` */
  effortDisabledReason?: string
  /** null = 清除覆盖（回到继承全局） */
  onSelectEffort: (effort: AgentReasoningEffort | null) => void

  // ── 档位集合（FR10：数据驱动，不得写死档位数）──
  /**
   * 该模型的可用档位集合（2–5 项，按产品枚举顺序，调用方已剔除不可用档位）。
   * 缺省 = 尚未拿到 availability，按 fail-open 渲染全部档位（§2.6 R3）。
   * 渲染路径始终由本 prop 驱动；兜底常量仅作缺省值，不构成「直接 map 枚举成 UI」的硬编码路径。
   */
  availableEfforts?: AgentReasoningEffort[]
}

/** composer 偏好合并入口（FR1/FR2）：单 chip + 一体化浮层（上模型 / 下强度），选中即关（FR2 末 / OQ-4）。 */
export function ComposerModelThinkingPicker({
  cfg,
  modelName,
  modelServiceName,
  modelDisplayName,
  modelUnavailable,
  onSelectModel,
  effort,
  effortOverridden,
  globalEffort,
  effortDisabled,
  effortDisabledReason,
  onSelectEffort,
  availableEfforts
}: Props) {
  const { t } = useTypedTranslation('chat')
  const [open, setOpen] = useState(false)
  const chipRef = useRef<HTMLButtonElement>(null)
  const modelTitleId = useId()
  const effortTitleId = useId()
  const options = useMemo(() => listChatModelOptions(cfg), [cfg])

  const effortLabel = (level: AgentReasoningEffort): string => t(`composer.thinking.${level}`)
  // FR3：模型段回退 modelName → cfg.model → 未配置模型；服务段仅歧义时存在，不留空括号
  const modelSegment = modelName || cfg.model || t('composer.prefs.unknownModel')
  const serviceSegment = modelServiceName
    ? t('composer.prefs.modelServiceSuffix', { service: modelServiceName })
    : ''
  const effortWord = effortLabel(effort)

  // FR5：title 给出完整信息（displayName 含服务前缀），继承时以「默认（全局档位）」注明
  const title = modelUnavailable
    ? t('modelPicker.unavailableHint')
    : t('composer.prefs.entryTitle', {
        displayName: modelDisplayName,
        effort: effortOverridden
          ? effortWord
          : t('composer.thinking.inheritWithGlobal', { effort: effortLabel(globalEffort) })
      })

  // FR10：渲染集合由 prop 驱动；缺省 fail-open 取产品枚举全集
  const efforts = availableEfforts ?? [...THINKING_EFFORT_LEVELS]
  // 兜底（FR10 例外，用户反馈）：生效档位不在可用集合（如调用方未接降级解析）时，
  // 以「· 当前」禁用项插入序列原位——否则收起态显示的档位在浮层中无处可寻，选中状态与列表割裂
  const renderable = useMemo(() => {
    if (efforts.includes(effort)) return efforts
    const merged = [...efforts]
    const insertAt = merged.findIndex(
      (l) => THINKING_EFFORT_LEVELS.indexOf(l) > THINKING_EFFORT_LEVELS.indexOf(effort)
    )
    if (insertAt === -1) merged.push(effort)
    else merged.splice(insertAt, 0, effort)
    return merged
  }, [efforts, effort])

  const closeAndRefocusChip = () => {
    setOpen(false)
    chipRef.current?.focus()
  }

  const modelSection = (
    <div className="composer-prefs__section">
      <div id={modelTitleId} className="composer-prefs__section-title">
        {t('composer.prefs.modelSection')}
      </div>
      <div className="composer-prefs__models composer-model-picker">
        {options.length === 0 ? (
          <div className="composer-model-picker__empty">{t('modelPicker.empty')}</div>
        ) : (
          <ul className="composer-model-picker__list" role="listbox" aria-labelledby={modelTitleId}>
            {options.map((opt) => {
              const active = opt.modelName === modelName
              return (
                <li key={`${opt.serviceId}:${opt.modelId}`} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={[
                      'composer-model-picker__item',
                      active ? 'composer-model-picker__item--active' : ''
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      onSelectModel(opt)
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
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )

  const effortSection = (
    <div className="composer-prefs__section">
      <div id={effortTitleId} className="composer-prefs__section-title">
        {t('composer.prefs.effortSection')}
      </div>
      <div
        className="composer-prefs__efforts"
        role="radiogroup"
        aria-labelledby={effortTitleId}
        aria-disabled={effortDisabled || undefined}
      >
        {renderable.map((level) => {
          // 「是否默认」是档位的属性而非独立选项：等于全局档位的项带「· 默认」，点它 = 清除覆盖（回调 null）
          const isDefaultSlot = level === globalEffort
          // 生效档位不被当前模型支持（兜底插入项）：只作当前值指示，不可选
          const isCurrentPlaceholder = level === effort && !efforts.includes(level)
          // 选中态跟随解析后的生效档位（继承时为全局档、被模型排除时为降级档）
          const selected = level === effort
          return (
            <button
              key={level}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={effortDisabled || isCurrentPlaceholder}
              title={isCurrentPlaceholder ? t('composer.prefs.effortCurrentHint') : undefined}
              className={[
                'composer-prefs__effort',
                selected ? 'composer-prefs__effort--active' : '',
                isCurrentPlaceholder ? 'composer-prefs__effort--current' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => {
                onSelectEffort(isDefaultSlot ? null : level)
                setOpen(false)
              }}
            >
              {isCurrentPlaceholder
                ? t('composer.prefs.effortCurrent', { effort: effortLabel(level) })
                : isDefaultSlot
                  ? t('composer.thinking.defaultSuffix', { effort: effortLabel(level) })
                  : effortLabel(level)}
            </button>
          )
        })}
      </div>
      {effortDisabled ? (
        <div className="composer-prefs__effort-disabled" role="note">
          {effortDisabledReason ?? t('composer.prefs.effortDisabled')}
        </div>
      ) : null}
    </div>
  )

  const content = (
    <div
      className="composer-prefs"
      onKeyDown={(e) => {
        // FR8：Esc 关闭并把焦点还给入口 chip（焦点在浮层内时 chip 收不到键盘事件，须在内容根上处理）
        if (e.key === 'Escape') closeAndRefocusChip()
      }}
    >
      {modelSection}
      <div className="composer-prefs__divider" role="separator" />
      {effortSection}
    </div>
  )

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="topLeft"
      classNames={{ root: 'composer-prefs-popover' }}
      content={content}
    >
      <button
        ref={chipRef}
        type="button"
        className={[
          'composer-model-chip',
          'composer-model-chip--button',
          open ? 'composer-model-chip--open' : '',
          modelUnavailable ? 'composer-model-chip--warn' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('composer.prefs.aria', { model: modelSegment, effort: effortWord })}
        title={title}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) closeAndRefocusChip()
        }}
      >
        <span className="composer-model-chip__label">
          {modelSegment}
          {serviceSegment ? <span className="composer-model-chip__service">{serviceSegment}</span> : null}
        </span>
        <span className="composer-model-chip__sep" aria-hidden="true">
          {t('composer.prefs.chipSeparator')}
        </span>
        <span className="composer-model-chip__effort">{effortWord}</span>
        <ChevronDown size={12} strokeWidth={2} className="composer-model-chip__chevron" aria-hidden />
      </button>
    </Popover>
  )
}
