/** Runs registration only after the executor has reported a successful filesystem mutation. */
export function registerAfterSuccessfulWrite(input: { success: boolean; register: () => void }): void {
  if (!input.success) return
  try {
    input.register()
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error'
    throw new Error(`文件已写入但登记失败：${detail}`)
  }
}
