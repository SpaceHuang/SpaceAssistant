import { describe, expect, it } from 'vitest'
import { getSessionLedgerRoots } from './sessionLedgerRoots'

describe('session ledger roots', () => {
  it('collects normalized configured roots and ignores malformed profiles without losing fallback', () => {
    expect(getSessionLedgerRoots('/workspace/default', JSON.stringify([
      { id: 'client', path: '/workspace/client' }, { id: '', path: ' ' }, null
    ]))).toEqual(['/workspace/default', '/workspace/client'])
    expect(getSessionLedgerRoots('/workspace/default', '{bad json')).toEqual(['/workspace/default'])
  })
})
