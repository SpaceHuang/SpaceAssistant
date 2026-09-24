export const SHELL_TUI_RULES = ['direct-program', 'npm-init', 'git-rebase-interactive'] as const
export type ShellTuiRule = typeof SHELL_TUI_RULES[number]
export const SHELL_TUI_UNDETECTABLE_REASONS = ['parse-incomplete', 'nested-command-unresolvable', 'recursion-depth-exceeded', 'shell-control-flow', 'command-position-untrusted', 'unsupported-wrapper'] as const
export type ShellTuiUndetectableReason = typeof SHELL_TUI_UNDETECTABLE_REASONS[number]
export interface ShellTuiMatch { program: string; rule: ShellTuiRule; via?: string[] }
