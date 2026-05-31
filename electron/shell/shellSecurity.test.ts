import { describe, expect, it } from 'vitest'
import { buildSecurityContext, getShellSecurityDenyMessage, runShellSecurityValidators } from './shellSecurity'
import type { ShellPathVerdict } from './shellTypes'

const emptyPath: ShellPathVerdict = {
  decision: 'ask',
  violations: [],
  warnings: [],
  outsideWorkDirRisk: false,
  requiresRiskAck: false
}

describe('shellSecurity', () => {
  it('denies command substitution', () => {
    const ctx = buildSecurityContext('echo $(whoami)', 'win32', 'C:\\app', ['echo $(whoami)'], emptyPath, [])
    const r = runShellSecurityValidators(ctx)
    expect(r.verdict).toBe('deny')
    expect(getShellSecurityDenyMessage(r.validatorId!)).toMatch(/命令替换/)
  })

  it('denies redirection', () => {
    const ctx = buildSecurityContext('echo x > file', 'win32', 'C:\\app', ['echo x > file'], emptyPath, [])
    expect(runShellSecurityValidators(ctx).verdict).toBe('deny')
  })

  it('denies sudo', () => {
    const ctx = buildSecurityContext('sudo apt update', 'linux', '/app', ['sudo apt update'], emptyPath, [])
    expect(runShellSecurityValidators(ctx).verdict).toBe('deny')
  })

  it('denies lark-cli', () => {
    const ctx = buildSecurityContext('lark-cli message send', 'linux', '/app', ['lark-cli message send'], emptyPath, [])
    expect(runShellSecurityValidators(ctx).verdict).toBe('deny')
  })

  it('allows npm install', () => {
    const ctx = buildSecurityContext('npm install', 'win32', 'C:\\app', ['npm install'], emptyPath, [])
    expect(runShellSecurityValidators(ctx).verdict).toBe('ask')
  })
})
