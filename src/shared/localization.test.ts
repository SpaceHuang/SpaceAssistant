import { describe, expect, it } from 'vitest'
import { interpolateMessage } from './localization'

describe('interpolateMessage（偏差 13:键化消息插值,i18next {{param}} 同款）', () => {
  it('无参数原样返回', () => {
    expect(interpolateMessage('文件', undefined)).toBe('文件')
    expect(interpolateMessage('文件', {})).toBe('文件')
  })

  it('单参数与多参数插值', () => {
    expect(interpolateMessage('会话：{{session}}', { session: 's1' })).toBe('会话：s1')
    expect(interpolateMessage('{{a}} 与 {{b}}', { a: 1, b: 'x' })).toBe('1 与 x')
  })

  it('同名参数多次出现全部替换;缺失参数保留占位原样', () => {
    expect(interpolateMessage('{{n}}-{{n}}', { n: 'k' })).toBe('k-k')
    expect(interpolateMessage('共 {{count}} 项', undefined)).toBe('共 {{count}} 项')
  })
})
