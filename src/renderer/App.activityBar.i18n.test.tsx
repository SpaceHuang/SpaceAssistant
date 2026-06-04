import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { changeAppLocale } from './i18n/localeSync'
import i18n from './i18n'

describe('activity bar i18n', () => {
  it('exposes English activity labels', async () => {
    await changeAppLocale('en-US')
    expect(i18n.t('activity.sessions', { ns: 'common' })).toBe('Sessions')
    expect(i18n.t('activity.search', { ns: 'common' })).toBe('Search')
    expect(i18n.t('activity.settings', { ns: 'common' })).toBe('Settings')
  })

  it('exposes Chinese activity labels', async () => {
    await changeAppLocale('zh-CN')
    expect(i18n.t('activity.sessions', { ns: 'common' })).toBe('会话')
    expect(i18n.t('activity.search', { ns: 'common' })).toBe('搜索')
  })
})
