import { describe, expect, it } from 'vitest'
import { getRendererURL, getUserDataPath, isSpaceAssistantDev } from './devEnvironment'

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

  it('开发模式可显式指定隔离 userData 目录', () => {
    expect(getUserDataPath('/Users/test/Library/Application Support/Electron', {
      SPACEASSISTANT_DEV: '1', SPACEASSISTANT_DEV_USER_DATA_DIR: '/tmp/spaceassistant-test-data'
    })).toBe('/tmp/spaceassistant-test-data')
  })

  it('生产模式忽略开发 userData 覆盖', () => {
    expect(getUserDataPath('/Users/test/Library/Application Support/Electron', {
      SPACEASSISTANT_DEV_USER_DATA_DIR: '/tmp/spaceassistant-test-data'
    })).toBe('/Users/test/Library/Application Support/Electron')
  })

  it('开发 userData 覆盖必须是绝对路径', () => {
    expect(() => getUserDataPath('/Users/test/Library/Application Support/Electron', {
      SPACEASSISTANT_DEV: '1', SPACEASSISTANT_DEV_USER_DATA_DIR: 'relative-path'
    })).toThrow('DEV_USER_DATA_DIR_MUST_BE_ABSOLUTE')
  })
})
