import { useSyncExternalStore } from 'react'
import { formatToolDuration } from '../../../shared/toolDurationFormat'

const listeners = new Set<() => void>()
let timer: number | undefined

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) timer = window.setInterval(() => { listeners.forEach((notify) => notify()) }, 1000)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== undefined) { window.clearInterval(timer); timer = undefined }
  }
}

const getSnapshot = () => Date.now()

export function McpElapsed({ startedAt }: { startedAt: number }) {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return <span data-testid="mcp-elapsed" className="tool-row__duration">{formatToolDuration(Math.max(0, current - startedAt))}</span>
}
