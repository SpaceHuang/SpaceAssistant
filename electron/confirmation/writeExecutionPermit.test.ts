import { describe, expect, it } from 'vitest'
import { buildWriteExecutionPermit, validateWriteExecutionPermit } from './writeExecutionPermit'
import type { WritePathFact } from './extractors/writePathFacts'

const fact: WritePathFact = {
  rawPath: '../outside/new.txt', normalizedPath: '/tmp/outside/new.txt', zone: 'outside-workdir', targetKind: 'missing',
  parentReal: '/tmp/outside', parentIdentity: { dev: 1, ino: 2, mode: 0o40755, size: 10, mtimeMs: 20, nlink: 1 }
}
const input = { path: '../outside/new.txt', content: 'data' }

describe('write execution permit', () => {
  it('绑定 request、toolUse、输入摘要和完整目标事实', () => {
    const permit = buildWriteExecutionPermit({ requestId: 'r1', toolUseId: 'u1', toolName: 'write_file', input, target: fact, decisionRuleId: 'write-outside-confirm', approval: 'confirmed' })
    expect(validateWriteExecutionPermit(permit, { requestId: 'r1', toolUseId: 'u1', toolName: 'write_file', input })).toEqual({ ok: true })
    expect(validateWriteExecutionPermit(permit, { requestId: 'r1', toolUseId: 'u2', toolName: 'write_file', input })).toMatchObject({ ok: false, caseId: 'write-permit-binding-mismatch' })
    expect(validateWriteExecutionPermit(permit, { requestId: 'r1', toolUseId: 'u1', toolName: 'write_file', input: { ...input, content: 'changed' } })).toMatchObject({ ok: false, caseId: 'write-input-digest-mismatch' })
  })

  it('许可独立保存并深冻结目标与父目录身份快照', () => {
    const mutableFact = structuredClone(fact)
    const permit = buildWriteExecutionPermit({ requestId: 'r1', toolUseId: 'u1', toolName: 'write_file', input, target: mutableFact, decisionRuleId: 'write-outside-confirm', approval: 'confirmed' })
    expect(Object.isFrozen(permit)).toBe(true)
    expect(Object.isFrozen(permit.target)).toBe(true)
    expect(Object.isFrozen(permit.target.parentIdentity)).toBe(true)
    expect(permit.target.parentIdentity).not.toBe(mutableFact.parentIdentity)

    mutableFact.parentIdentity.ino = 99
    expect(permit.target.parentIdentity.ino).toBe(2)
    expect(validateWriteExecutionPermit(permit, { requestId: 'r1', toolUseId: 'u1', toolName: 'write_file', input })).toEqual({ ok: true })
  })
})
