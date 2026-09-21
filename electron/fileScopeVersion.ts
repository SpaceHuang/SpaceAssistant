/**
 * 偏差 11/3a:文件域统一单调计数器。
 * 不用 mtime 作版本(目录 mtime 不反映子孙变化、同 tick 多写可取同值);
 * 主进程内存原子自增,启动从 1 开始(渲染端基线 0 → 首个通知必然触发重取)。
 */
let counter = 0

export function nextFileScopeVersion(): number {
  counter += 1
  return counter
}

export function peekFileScopeVersion(): number {
  return counter
}

/** @internal test helper */
export function resetFileScopeVersionForTests(n = 0): void {
  counter = n
}
