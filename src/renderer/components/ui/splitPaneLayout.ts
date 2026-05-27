/** 根据 app-shell 可用宽度计算侧栏最大宽度（保证中间主区满足 min-width） */
export function maxSplitPaneSize(
  shell: Element,
  side: 'left' | 'right',
  minSize: number,
  maxSize: number
): number {
  const shellW = shell.getBoundingClientRect().width
  if (!Number.isFinite(shellW) || shellW <= 0) return maxSize

  const main = shell.querySelector<HTMLElement>('.app-main')
  const mainMinRaw = main ? Number.parseFloat(getComputedStyle(main).minWidth) : NaN
  const mainMin = Number.isFinite(mainMinRaw) ? mainMinRaw : 400

  const left = shell.querySelector<HTMLElement>('.app-sider')
  const right = shell.querySelector<HTMLElement>('.app-detail-sider')
  const siblingW =
    side === 'right'
      ? (left?.getBoundingClientRect().width ?? 0)
      : (right?.getBoundingClientRect().width ?? 0)

  const available = shellW - siblingW - mainMin
  if (!Number.isFinite(available)) return maxSize
  return Math.min(maxSize, Math.max(minSize, available))
}

export function clampSplitPaneSize(
  shell: Element,
  side: 'left' | 'right',
  size: number,
  minSize: number,
  maxSize: number
): number {
  const cap = maxSplitPaneSize(shell, side, minSize, maxSize)
  return Math.min(maxSize, Math.max(minSize, Math.min(size, cap)))
}
