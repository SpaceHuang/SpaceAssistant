import { useCallback, useRef } from 'react'

interface ResizeHandleProps {
  onResize: (ratio: number) => void
  currentRatio: number
  minRatio?: number
  maxRatio?: number
  onDoubleClick?: () => void
}

/** 引用文件列表最小高度（飞书状态栏为独立网格行，不计入此比例） */
const MIN_REFERENCED_FILES_PX = 80
/** 与 detailPanel.css --feishu-remote-status-bar-height 一致 */
const FEISHU_STATUS_BAR_PX = 32

export function ResizeHandle({ onResize, currentRatio, minRatio = 0.15, maxRatio = 0.85, onDoubleClick }: ResizeHandleProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const dragState = useRef<{ startY: number; startBottomHeight: number; containerHeight: number } | null>(null)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const container = containerRef.current?.parentElement
      const handleEl = containerRef.current
      if (!container || !handleEl) return
      const containerHeight = container.clientHeight - handleEl.offsetHeight - FEISHU_STATUS_BAR_PX
      dragState.current = {
        startY: e.clientY,
        startBottomHeight: currentRatio * containerHeight,
        containerHeight,
      }

      const handleMouseMove = (ev: MouseEvent) => {
        if (!dragState.current) return
        const delta = ev.clientY - dragState.current.startY
        const newBottomHeight = dragState.current.startBottomHeight - delta
        const ratio = newBottomHeight / dragState.current.containerHeight
        const minR = Math.max(minRatio, MIN_REFERENCED_FILES_PX / dragState.current.containerHeight)
        const maxR = Math.min(maxRatio, 1 - MIN_REFERENCED_FILES_PX / dragState.current.containerHeight)
        const clamped = Math.min(maxR, Math.max(minR, ratio))
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
    [onResize, currentRatio, minRatio, maxRatio]
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
