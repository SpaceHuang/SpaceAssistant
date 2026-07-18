/** Runs registration only after the executor has reported a successful filesystem mutation. */
export function registerAfterSuccessfulWrite(input: { success: boolean; register: () => void }): void {
  if (!input.success) return
  input.register()
}
