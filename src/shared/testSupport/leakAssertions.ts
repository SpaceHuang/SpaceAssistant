/** 测试用统一泄漏断言，不依赖 Vitest，便于 Electron/renderer 共用。 */
export function assertNoSensitiveValues(serialized: string, sensitiveValues: string[]): void {
  for (const value of sensitiveValues) {
    if (value && serialized.includes(value)) {
      throw new Error(`sensitive value leaked: ${value}`)
    }
  }
}
