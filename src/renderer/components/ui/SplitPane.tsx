import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

const STORAGE_PREFIX = 'sa.layout.'

type Props = {
  id: string
  defaultSize: number
  minSize: number
  maxSize: number
  side: 'left' | 'right'
  children: ReactNode
  className?: string
}

export function SplitPane({ id, defaultSize, minSize, maxSize, side, children, className }: Props) {
  const storageKey = `${STORAGE_PREFIX}${id}`
  const [size, setSize] = useState(() => {
    const saved = localStorage.getItem(storageKey)
    const n = saved ? Number(saved) : defaultSize
    return Number.isFinite(n) ? Math.min(maxSize, Math.max(minSize, n)) : defaultSize
  })
  const [isDragging, setIsDragging] = useState(false)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startSize = useRef(size)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      dragging.current = true
      setIsDragging(true)
      startX.current = e.clientX
      startSize.current = size
      e.currentTarget.setPointerCapture(e.pointerId)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [size]
  )

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return
      const delta = e.clientX - startX.current
      const next = side === 'left' ? startSize.current + delta : startSize.current - delta
      setSize(Math.min(maxSize, Math.max(minSize, next)))
    }
    const onUp = () => {
      if (!dragging.current) return
      dragging.current = false
      setIsDragging(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [maxSize, minSize, side])

  useEffect(() => {
    localStorage.setItem(storageKey, String(size))
  }, [size, storageKey])

  return (
    <div
      className={className}
      style={{
        width: size,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        height: '100%',
        borderRight: side === 'left' ? '1px solid var(--sa-border)' : undefined,
        borderLeft: side === 'right' ? '1px solid var(--sa-border)' : undefined
      }}
    >
      <div className="sa-split-pane-body">{children}</div>
      <div
        className={`sa-splitter${isDragging ? ' sa-splitter--dragging' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={size}
        onPointerDown={onPointerDown}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          [side === 'left' ? 'right' : 'left']: -2,
          width: 4
        }}
      />
    </div>
  )
}
