import { useEffect, useMemo } from 'react'
import { App, ConfigProvider, theme as antTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { useTypedSelector } from '../hooks'
import { useResolvedTheme } from './useResolvedTheme'

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const uiTheme = useTypedSelector((s) => s.config.config?.uiTheme ?? 'system')
  const resolved = useResolvedTheme(uiTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = resolved
  }, [resolved])

  const antConfig = useMemo(
    () => ({
      algorithm: resolved === 'dark' ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
      token: {
        colorPrimary: '#0a84ff',
        borderRadius: 8,
        fontFamily: 'var(--sa-font-sans)'
      }
    }),
    [resolved]
  )

  return (
    <ConfigProvider locale={zhCN} theme={antConfig}>
      <App>{children}</App>
    </ConfigProvider>
  )
}
