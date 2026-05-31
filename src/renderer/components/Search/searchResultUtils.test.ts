import { describe, expect, it } from 'vitest'
import type { SearchResult } from '../../../shared/domainTypes'
import {
  getFileDirname,
  shouldShowSessionAuxiliary,
  getSessionAuxiliaryText,
  getFileAuxiliaryText
} from './searchResultUtils'

describe('searchResultUtils', () => {
  it('getFileDirname returns parent directory', () => {
    expect(getFileDirname('src/utils/perf.ts')).toBe('src/utils')
    expect(getFileDirname('README.md')).toBe('')
  })

  it('shouldShowSessionAuxiliary is false when title equals session name', () => {
    expect(shouldShowSessionAuxiliary('性能讨论', '性能讨论')).toBe(false)
  })

  it('shouldShowSessionAuxiliary is true when title differs from session name', () => {
    expect(shouldShowSessionAuxiliary('如何优化渲染', '性能讨论')).toBe(true)
  })

  it('getSessionAuxiliaryText omits when title is session name', () => {
    const item: SearchResult = {
      id: 'msg:1',
      type: 'session',
      title: '性能讨论',
      preview: 'hello',
      sessionId: 's1',
      messageId: 'm1'
    }
    expect(getSessionAuxiliaryText(item)).toBeNull()
  })

  it('getFileAuxiliaryText returns directory path', () => {
    const item: SearchResult = {
      id: 'file:1',
      type: 'file',
      title: 'src/utils/perf.ts',
      preview: 'memoize',
      path: 'src/utils/perf.ts'
    }
    expect(getFileAuxiliaryText(item)).toBe('src/utils')
  })
})
