import { describe, expect, it } from 'vitest'
import { getRendererURL, isSpaceAssistantDev } from './devEnvironment'

describe('开发环境配置', () => {
  it('仅使用独立开发标志判断是否隔离 userData', () => {
    expect(isSpaceAssistantDev({ SPACEASSISTANT_DEV: '1', ELECTRON_START_URL: '' })).toBe(true)
    expect(isSpaceAssistantDev({ ELECTRON_START_URL: 'http://127.0.0.1:9240' })).toBe(false)
  })

  it('使用自定义 Vite 端口生成 renderer 地址', () => {
    expect(getRendererURL({ VITE_DEV_SERVER_PORT: '9321' })).toBe('http://127.0.0.1:9321')
  })

  it('显式 ELECTRON_START_URL 优先于 Vite 端口', () => {
    expect(getRendererURL({ ELECTRON_START_URL: 'http://localhost:9999', VITE_DEV_SERVER_PORT: '9321' })).toBe('http://localhost:9999')
  })
})
