import { useEffect, useState } from 'react'
import type { UiThemeMode } from '../../shared/domainTypes'

export type ResolvedTheme = 'light' | 'dark'

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function resolveTheme(mode: UiThemeMode): ResolvedTheme {
  if (mode === 'system') return getSystemTheme()
  return mode
}

export function useResolvedTheme(mode: UiThemeMode): ResolvedTheme {
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(mode))

  useEffect(() => {
    setResolved(resolveTheme(mode))
    if (mode !== 'system') return

    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setResolved(getSystemTheme())
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [mode])

  return resolved
}
