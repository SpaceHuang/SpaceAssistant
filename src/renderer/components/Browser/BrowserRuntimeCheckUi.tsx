type RuntimeCheckTone = 'success' | 'warning'

export function ExpandChevronIcon() {
  return (
    <svg
      className="browser-runtime-check-row__chevron"
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path fill="currentColor" d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z" />
    </svg>
  )
}

export function BrowserRuntimeCheckCompactRow({
  tone,
  children,
  className
}: {
  tone: RuntimeCheckTone
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={`browser-runtime-check-row browser-runtime-check-row--${tone} ${className ?? ''}`.trim()}
    >
      <span className="browser-runtime-check-row__dot" aria-hidden />
      <span className="browser-runtime-check-row__text">{children}</span>
    </div>
  )
}

export function BrowserDetectDetailValue({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span className={ok ? 'browser-detect-detail__ok' : 'browser-detect-detail__fail'}>{children}</span>
  )
}
