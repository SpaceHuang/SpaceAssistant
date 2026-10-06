import { describe, expect, it } from 'vitest'
import { classifySessionHistoryRepairFailure } from './sessionHistoryRecoveryDiagnostics'

describe('classifySessionHistoryRepairFailure', () => {
  it('maps known storage and canonical validation failures to fixed safe categories', () => {
    expect(classifySessionHistoryRepairFailure(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })))
      .toBe('sqlite-busy')
    expect(classifySessionHistoryRepairFailure(new Error('canonical tool result identity does not match its proposal')))
      .toBe('canonical-projection-rejected')
    expect(classifySessionHistoryRepairFailure(new Error('canonical model request ledger location does not match a configured workspace root')))
      .toBe('workspace-root-rejected')
    expect(classifySessionHistoryRepairFailure(Object.assign(new Error('file missing'), { code: 'ENOENT' })))
      .toBe('storage-object-missing')
  })

  it('never returns arbitrary error messages or identifiers as a diagnostic category', () => {
    const secret = 'private-session-42 transcript text /Users/private'
    const category = classifySessionHistoryRepairFailure(new Error(secret))

    expect(category).toBe('projection-repair-failed')
    expect(category).not.toContain(secret)
  })

  it('handles non-Error callback failures without serializing their values', () => {
    expect(classifySessionHistoryRepairFailure({ code: 'SQLITE_IOERR', detail: 'private body' }))
      .toBe('sqlite-io-error')
    expect(classifySessionHistoryRepairFailure('private failure text')).toBe('unknown-repair-failure')
  })
})
