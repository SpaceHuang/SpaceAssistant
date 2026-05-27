import type { ReactNode } from 'react'

type Props = {
  title: string
  collapsed: boolean
  onToggle: () => void
  flexGrow: number
  headerExtra?: ReactNode
  children: ReactNode
}

export function FilePaneSection({ title, collapsed, onToggle, flexGrow, headerExtra, children }: Props) {
  return (
    <section
      className={`file-pane-section${collapsed ? ' file-pane-section--collapsed' : ''}`}
      style={collapsed ? undefined : { flex: `${flexGrow} 1 0` }}
    >
      <div className="file-pane-section-header">
        <button type="button" className="file-pane-section-toggle" onClick={onToggle}>
          <span className="file-pane-section-chevron">{collapsed ? '▶' : '▼'}</span>
          <span className="file-pane-section-title">{title}</span>
        </button>
        {headerExtra ? <div className="file-pane-section-actions">{headerExtra}</div> : null}
      </div>
      <div className={`file-pane-section-body${collapsed ? ' file-pane-section-body--hidden' : ''}`}>{children}</div>
    </section>
  )
}
