import { describe, expect, it } from 'vitest'
import { getScriptClassDisposition, SCRIPT_FINDING_CLASSES } from './scriptClassDisposition'

describe('script class disposition', () => {
  it('maps every finding class to one policy disposition', () => {
    expect(SCRIPT_FINDING_CLASSES).toEqual([
      'process-creation', 'destructive-fs', 'dynamic-execution', 'dynamic-import',
      'native-code-load', 'network-api', 'file-write', 'cwd-change',
      'reflection', 'alias-resolution', 'decode-then-exec', 'dynamic-dispatch'
    ])
    for (const findingClass of SCRIPT_FINDING_CLASSES) {
      expect(getScriptClassDisposition(findingClass).action).toMatch(/^(allow|ask|deny)$/)
    }
  })

  it.each([
    ['process-creation', undefined, 'ask'],
    ['destructive-fs', undefined, 'ask'],
    ['dynamic-execution', undefined, 'ask'],
    ['dynamic-import', undefined, 'ask'],
    ['native-code-load', undefined, 'deny'],
    ['network-api', undefined, 'ask'],
    ['reflection', undefined, 'ask'],
    ['alias-resolution', undefined, 'ask'],
    ['decode-then-exec', undefined, 'ask'],
    ['dynamic-dispatch', undefined, 'ask'],
    ['file-write', 'absolute', 'deny'],
    ['file-write', 'dotdot', 'deny'],
    ['file-write', 'relative', 'allow'],
    ['file-write', 'unresolved', 'ask'],
    ['cwd-change', undefined, 'allow']
  ] as const)('%s / %s has disposition %s', (findingClass, pathClass, action) => {
    expect(getScriptClassDisposition(findingClass, pathClass).action).toBe(action)
  })

  it('uses ask as a fail-closed fallback for an unrecognized runtime class', () => {
    expect(getScriptClassDisposition('future-class' as never).action).toBe('ask')
  })
})
