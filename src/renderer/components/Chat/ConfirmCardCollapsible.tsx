import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

const COLLAPSED_LINES = 10
const EXPANDED_MAX_HEIGHT_PX = 360

type Props = {
  children: ReactNode
  lineCount: number
  className?: string
}

export function ConfirmCardCollapsible({ children, lineCount, className }: Props) {
  const [expanded, setExpanded] = useState(false)
  const canExpand = lineCount > COLLAPSED_LINES

  return (
    <div
      className={[
        'write-confirm-card__collapsible',
        expanded ? 'write-confirm-card__collapsible--expanded' : '',
        canExpand ? 'write-confirm-card__collapsible--clamped' : '',
        className ?? ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div
        className="write-confirm-card__collapsible-viewport"
        style={expanded && canExpand ? { maxHeight: `${EXPANDED_MAX_HEIGHT_PX}px` } : undefined}
      >
        {children}
      </div>
      {canExpand ? (
        <div className="write-confirm-card__collapsible-bar">
          <button
            type="button"
            className="write-confirm-card__expand-btn"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <span>{expanded ? '收起预览' : `展开全部（共 ${lineCount} 行）`}</span>
            <ChevronDown
              size={14}
              strokeWidth={2.25}
              className="write-confirm-card__expand-btn-icon"
              aria-hidden
            />
          </button>
        </div>
      ) : null}
    </div>
  )
}
