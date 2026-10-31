export function scheduleAfterFirstPaint(task: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(task))
}
