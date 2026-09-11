/** 测试用统一泄漏断言，不依赖 Vitest，便于 Electron/renderer 共用。 */
export function assertNoSensitiveValues(serialized: string, sensitiveValues: string[]): void {
  for (const [index, value] of sensitiveValues.entries()) {
    if (value && serialized.includes(value)) {
      // 只报位置与长度：失败消息会进 CI 日志，直接回显敏感值等于二次泄漏。
      throw new Error(`sensitive value leaked: index=${index} length=${value.length}`)
    }
  }
}
