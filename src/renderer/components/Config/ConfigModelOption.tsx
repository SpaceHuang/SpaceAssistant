import type { ModelEntry } from '../../../shared/domainTypes'

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`
  return String(n)
}

function FastBadgeIcon() {
  return (
    <svg className="config-model-badge__icon" xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" aria-hidden>
      <path fill="currentColor" d="M13 2 4 14h7l-1 8 9-12h-7z" />
    </svg>
  )
}

function ConfigModelFastBadge() {
  return (
    <span className="config-model-badge config-model-badge--fast">
      <FastBadgeIcon />
      <span>快速</span>
    </span>
  )
}

type ConfigModelOptionContentProps = {
  m: ModelEntry
  selected?: boolean
  /** 仅名称 + 快速标签，11px，无上下文元信息 */
  compact?: boolean
}

export function ConfigModelOptionContent({ m, selected, compact }: ConfigModelOptionContentProps) {
  return (
    <div
      className={[
        'config-model-option',
        selected ? 'config-model-option--selected' : '',
        compact ? 'config-model-option--compact' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="config-model-option__row">
        <span className="config-model-option__name">{m.name}</span>
        {m.isFast ? <ConfigModelFastBadge /> : null}
      </div>
      {!compact ? (
        <div className="config-model-option__meta">
          上下文 {formatNumber(m.maximumContext)} · 输出 {formatNumber(m.maxTokens)}
        </div>
      ) : null}
    </div>
  )
}

/** 快速模型排在列表最前，其余保持原顺序 */
export function sortModelsFastFirst(models: ModelEntry[]): ModelEntry[] {
  const fast: ModelEntry[] = []
  const rest: ModelEntry[] = []
  for (const m of models) {
    if (m.isFast) fast.push(m)
    else rest.push(m)
  }
  return [...fast, ...rest]
}
