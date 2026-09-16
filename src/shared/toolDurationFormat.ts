export function formatToolDuration(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) {
    const seconds = Math.round(ms / 100) / 10
    return `${Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1)}s`
  }
  const totalSeconds = Math.round(ms / 1000)
  return `${Math.floor(totalSeconds / 60)} 分 ${(totalSeconds % 60).toString().padStart(2, '0')} 秒`
}
