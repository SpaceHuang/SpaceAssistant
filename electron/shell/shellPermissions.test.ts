import { describe, expect, it } from 'vitest'
import { evaluateShellPermission } from './shellPermissions'

describe('shellPermissions', () => {
  it('builtin deny sudo', () => {
    const r = evaluateShellPermission('sudo rm -rf /', ['sudo rm -rf /'])
    expect(r.decision).toBe('deny')
    expect(r.builtin).toBe(true)
  })

  it('user allow skips confirm path', () => {
    const r = evaluateShellPermission('git status', ['git status'], [
      { id: '1', pattern: 'git status', decision: 'allow' }
    ])
    expect(r.decision).toBe('allow')
  })

  it('defaults to ask', () => {
    expect(evaluateShellPermission('npm install', ['npm install']).decision).toBe('ask')
  })
})
