export const SHELL_CASE_IDS = {
  unboundedOutput: 'SHELL-OUTPUT-001',
  outputPersistFailed: 'SHELL-OUTPUT-002',
  progressFlood: 'SHELL-PROGRESS-001',
  tuiRequiresTerminal: 'SHELL-CAPABILITY-001',
  dialectMismatch: 'SHELL-DIALECT-001',
  terminationUnconfirmed: 'SHELL-LIFECYCLE-001',
  processTreeRecovery: 'SHELL-LIFECYCLE-002',
  spawnError: 'SHELL-LIFECYCLE-003',
  promiseConvergence: 'SHELL-LIFECYCLE-004',
  planInvalid: 'SHELL-PLAN-001',
  executableUnavailable: 'SHELL-CAPABILITY-002'
} as const

export type ShellCaseId = (typeof SHELL_CASE_IDS)[keyof typeof SHELL_CASE_IDS]
