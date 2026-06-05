import { useEffect, useMemo, useState } from 'react'
import { App, ConfigProvider, theme as antTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import i18n from '../i18n'

function getAntdLocale(lang: string) {
  return lang.startsWith('zh') ? zhCN : enUS
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLang] = useState(i18n.language)

  useEffect(() => {
    const handler = (nextLang: string) => setLang(nextLang)
    i18n.on('languageChanged', handler)
    return () => {
      i18n.off('languageChanged', handler)
    }
  }, [])

  const antConfig = useMemo(
    () => ({
      algorithm: antTheme.defaultAlgorithm,
      token: {
        colorPrimary: '#f06529',
        borderRadius: 10,
        fontFamily: 'var(--sa-font-sans)',
        fontSize: 13,
        lineHeight: 1.5,
        colorBgContainer: '#fefdfb',
        colorBgLayout: '#faf9f6',
        colorBorderSecondary: '#e5e0d8'
      }
    }),
    []
  )

  return (
    <ConfigProvider locale={getAntdLocale(lang)} theme={antConfig}>
      <App>{children}</App>
    </ConfigProvider>
  )
}
