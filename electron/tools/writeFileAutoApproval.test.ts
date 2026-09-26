import { describe, expect, it } from 'vitest'
import { evaluateWriteFileAutoApproval } from './writeFileAutoApproval'
import type { WritePathFact } from '../confirmation/extractors/writePathFacts'

const base = {
  absPath: '/work/notes.txt',
  relPath: 'notes.txt',
  workDir: '/work',
  autoApproveMaxBytes: 1024,
  autoApproveMaxEditChars: 500
}

describe('evaluateWriteFileAutoApproval', () => {
  it('approves safe small write', () => {
    expect(evaluateWriteFileAutoApproval({ ...base, contentBytes: 100 })).toEqual({ approve: true })
  })

  it('rejects sensitive path', () => {
    const result = evaluateWriteFileAutoApproval({
      ...base,
      absPath: '/work/.env',
      relPath: '.env',
      contentBytes: 10
    })
    expect(result.approve).toBe(false)
    if (!result.approve) expect(result.reasonCode).toBe('sensitive_path')
  })

  it('rejects oversize content', () => {
    const result = evaluateWriteFileAutoApproval({ ...base, contentBytes: 2048 })
    expect(result.approve).toBe(false)
    if (!result.approve) expect(result.reasonCode).toBe('oversize')
  })

  it('rejects large edit span', () => {
    const result = evaluateWriteFileAutoApproval({ ...base, editCharSpan: 600 })
    expect(result.approve).toBe(false)
    if (!result.approve) expect(result.reasonCode).toBe('edit_too_large')
  })

  it('uses the gate write fact and blocks an outside target', () => {
    const fact: WritePathFact = {
      rawPath: '/outside/new.txt', normalizedPath: '/outside/new.txt', zone: 'outside-workdir', targetKind: 'missing',
      parentReal: '/outside', parentIdentity: { dev: 1, ino: 2, mode: 0o40755, size: 0, mtimeMs: 1, nlink: 1 }
    }
    expect(evaluateWriteFileAutoApproval({ ...base, absPath: fact.normalizedPath, relPath: fact.rawPath, targetZone: fact.zone, contentBytes: 1 }))
      .toMatchObject({ approve: false, reasonCode: 'outside_workdir' })
  })
})
