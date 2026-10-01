import { afterEach, describe, expect, it } from 'vitest'
import i18n from '../../src/renderer/i18n'
import { runtimeText } from '../../src/renderer/i18n/runtimeText'

const initialLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(initialLanguage)
})

describe('runtimeText', () => {
  it('resolves migrated runtime labels in Chinese and English', async () => {
    await i18n.changeLanguage('zh-CN')
    expect(runtimeText('detailPanel.configureWorkDirFirst')).toBe('请先配置工作目录')

    await i18n.changeLanguage('en-US')
    expect(runtimeText('detailPanel.configureWorkDirFirst')).toBe('Configure a working directory first')
  })

  it('interpolates values and respects an explicit locale for number units', async () => {
    await i18n.changeLanguage('en-US')
    expect(runtimeText('chat.shell.exitCode', { code: 7 })).toBe('Exit code 7')
    expect(runtimeText('usage.compactTenThousands', { value: '5.9', lng: 'zh-CN' })).toBe('5.9 万')
  })
})
