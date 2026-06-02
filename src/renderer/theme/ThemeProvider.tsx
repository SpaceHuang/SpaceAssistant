import { useMemo } from 'react'
import { App, ConfigProvider, theme as antTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const antConfig = useMemo(
    () => ({
      algorithm: antTheme.defaultAlgorithm,
      token: {
        colorPrimary: '#0a84ff',
        borderRadius: 8,
        fontFamily: 'var(--sa-font-sans)',
        fontSize: 13,
        lineHeight: 1.5
      }
    }),
    []
  )

  return (
    <ConfigProvider locale={zhCN} theme={antConfig}>
      <App>{children}</App>
    </ConfigProvider>
  )
}
