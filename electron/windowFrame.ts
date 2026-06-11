import type { BrowserWindowConstructorOptions } from 'electron'

export const TITLE_BAR_HEIGHT = 32

export function getMainWindowFrameOptions(): BrowserWindowConstructorOptions {
  const isMac = process.platform === 'darwin'

  if (isMac) {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 10 }
    }
  }

  return {
    frame: false
  }
}
