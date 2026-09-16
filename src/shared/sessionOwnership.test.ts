import { describe, expect, it } from 'vitest'
import {
  isSessionOwnership,
  isSessionVisibility,
  shouldAppearInPrimaryListView,
  shouldAppearInSearch,
  isButlerSectionSession,
  normalizeOwnership,
  normalizeVisibility
} from './sessionOwnership'

function s(ownership?: string, visibility?: string) {
  return {
    ...(ownership !== undefined ? { ownership } : {}),
    ...(visibility !== undefined ? { visibility } : {})
  }
}

describe('会话归属与可见性谓词（偏差 7）', () => {
  it('闭合联合类型守卫', () => {
    for (const v of ['user', 'remote', 'automation', 'internal']) expect(isSessionOwnership(v)).toBe(true)
    expect(isSessionOwnership('other')).toBe(false)
    for (const v of ['primary', 'section', 'hidden']) expect(isSessionVisibility(v)).toBe(true)
    expect(isSessionVisibility('other')).toBe(false)
  })

  it('四归属 × 三可见性矩阵：主列表视角（internal/hidden 永不进；section 不进主列表）', () => {
    const ownerships = ['user', 'remote', 'automation', 'internal'] as const
    const visibilities = ['primary', 'section', 'hidden'] as const
    for (const o of ownerships) {
      for (const v of visibilities) {
        const session = s(o, v)
        const expected = o !== 'internal' && v !== 'hidden' && v !== 'section'
        expect(shouldAppearInPrimaryListView(session)).toBe(expected)
      }
    }
  })

  it('缺省字段向后兼容：旧会话（无 ownership/visibility）等价 user/primary', () => {
    expect(shouldAppearInPrimaryListView(s())).toBe(true)
    expect(shouldAppearInSearch(s())).toBe(true)
    expect(normalizeOwnership(undefined)).toBe('user')
    expect(normalizeVisibility(undefined)).toBe('primary')
    expect(normalizeOwnership('bogus')).toBe('user')
    expect(normalizeVisibility('bogus')).toBe('primary')
  })

  it('跨会话搜索：internal 永不进；automation/section 进（v1 跟随谓词配置）', () => {
    expect(shouldAppearInSearch(s('internal', 'primary'))).toBe(false)
    expect(shouldAppearInSearch(s('internal', 'hidden'))).toBe(false)
    expect(shouldAppearInSearch(s('automation', 'section'))).toBe(true)
    expect(shouldAppearInSearch(s('user', 'primary'))).toBe(true)
    expect(shouldAppearInSearch(s('remote', 'primary'))).toBe(true)
  })

  it('管家分区谓词：automation + section', () => {
    expect(isButlerSectionSession(s('automation', 'section'))).toBe(true)
    expect(isButlerSectionSession(s('automation', 'primary'))).toBe(false)
    expect(isButlerSectionSession(s('user', 'section'))).toBe(false)
  })
})
