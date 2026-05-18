import { useCallback, useRef } from 'react'

interface ResizeHandleProps {
  onResize: (ratio: number) => void
  minRatio?: number
  maxRatio?: number
  onDoubleClick?: () => void
}

export function ResizeHandle({ onResize, minRatio = 0.15, maxRatio = 0.85, onDoubleClick }: ResizeHandleProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const dragState = useRef<{ startY: number; startRatio: number; containerHeight: number } | null>(null)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const container = containerRef.current?.parentElement
      if (!container) return
      dragState.current = {
        startY: e.clientY,
        startRatio: 0.5,
        containerHeight: container.clientHeight,
      }

      const handleMouseMove = (ev: MouseEvent) => {
        if (!dragState.current) return
        const delta = ev.clientY - dragState.current.startY
        const ratio = 1 - (dragState.current.containerHeight - delta) / dragState.current.containerHeight
        const clamped = Math.min(maxRatio, Math.max(minRatio, ratio))
        onResize(clamped)
      }

      const handleMouseUp = () => {
        dragState.current = null
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [onResize, minRatio, maxRatio]
  )

  return (
    <div
      ref={containerRef}
      className="detail-resize-handle"
      onMouseDown={handleMouseDown}
      onDoubleClick={onDoubleClick}
    />
  )
}