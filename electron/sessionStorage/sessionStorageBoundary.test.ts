import { describe, expect, it } from 'vitest'
import { findProtectedSessionStorageImports } from '../../scripts/check-session-storage-boundary.mjs'

describe('session storage dependency boundary parser', () => {
  it('finds named imports, renamed imports, re-exports, require, and dynamic import', () => {
    const source = `
      import { getMessage as readMessage, getSession } from '../database'
      export { updateMessageContent } from '../database/operations'
      const history = require('../runtime/sqliteAgentHistory')
      const projection = import('../runtime/sessionTranscriptProjection')
    `
    const violations = findProtectedSessionStorageImports('electron/ipc/example.ts', source)
    expect(violations.map(({ specifier, symbols }) => [specifier, symbols])).toEqual([
      ['../database', ['getMessage', 'getSession']],
      ['../database/operations', ['updateMessageContent']],
      ['../runtime/sqliteAgentHistory', null],
      ['../runtime/sessionTranscriptProjection', null]
    ])
  })

  it('ignores comments and allows non-session database operations', () => {
    const source = `
      // import { getMessage } from '../database'
      import { setConfigValue } from '../database/operations'
    `
    expect(findProtectedSessionStorageImports('electron/ipc/example.ts', source)).toEqual([])
  })

  it('resolves explicit database barrels before applying protected symbol rules', () => {
    const source = `import { getMessage } from '../database/index'`
    expect(findProtectedSessionStorageImports('electron/ipc/example.ts', source)).toEqual([
      { specifier: '../database/index', symbols: ['getMessage'] }
    ])
  })
})
