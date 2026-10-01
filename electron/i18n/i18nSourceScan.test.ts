import { describe, expect, it } from 'vitest'
import { findHardcodedChinese } from '../../scripts/i18n/i18nSourceScan'

describe('findHardcodedChinese', () => {
  it('ignores comments while finding Chinese runtime strings and JSX text', () => {
    const source = `
      // 中文注释不属于界面文案
      const label = '设置'
      const view = <button>保存</button>
    `

    expect(findHardcodedChinese(source, 'fixture.tsx')).toEqual([
      { line: 3, text: '设置' },
      { line: 4, text: '保存' }
    ])
  })

  it('finds Chinese in template segments, including segments around expressions', () => {
    const source = "const summary = `已选择 ${count} 个文件`"

    expect(findHardcodedChinese(source, 'fixture.ts')).toEqual([
      { line: 1, text: '已选择 ' },
      { line: 1, text: ' 个文件' }
    ])
  })

  it('does not flag translated keys or English-only literals', () => {
    expect(findHardcodedChinese("const label = t('actions.save'); const code = 'E_FAILED'", 'fixture.ts')).toEqual([])
  })
})
