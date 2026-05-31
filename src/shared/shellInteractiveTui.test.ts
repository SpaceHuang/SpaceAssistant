import { describe, expect, it } from 'vitest'
import { isInteractiveShellTuiCommand } from './shellInteractiveTui'

describe('isInteractiveShellTuiCommand', () => {
  it('detects common TUI commands', () => {
    expect(isInteractiveShellTuiCommand('less README.md')).toBe(true)
    expect(isInteractiveShellTuiCommand('vim src/main.ts')).toBe(true)
    expect(isInteractiveShellTuiCommand('top')).toBe(true)
    expect(isInteractiveShellTuiCommand('npm init')).toBe(true)
    expect(isInteractiveShellTuiCommand('git rebase -i HEAD~3')).toBe(true)
  })

  it('allows non-interactive equivalents', () => {
    expect(isInteractiveShellTuiCommand('npm init -y')).toBe(false)
    expect(isInteractiveShellTuiCommand('git --no-pager log -1')).toBe(false)
    expect(isInteractiveShellTuiCommand('npm install')).toBe(false)
    expect(isInteractiveShellTuiCommand('echo hello')).toBe(false)
  })
})
