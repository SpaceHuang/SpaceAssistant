if (typeof localStorage === 'undefined') {
  const store: Record<string, string> = {}
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value
      },
      removeItem: (key: string) => {
        delete store[key]
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k]
      },
      get length() {
        return Object.keys(store).length
      },
      key: (i: number) => Object.keys(store)[i] ?? null
    },
    writable: true
  })
}

if (typeof window !== 'undefined' && !window.localStorage) {
  Object.defineProperty(window, 'localStorage', {
    value: globalThis.localStorage,
    writable: true
  })
}

import '../renderer/i18n'
import { beforeEach } from 'vitest'
import { changeAppLocale } from '../renderer/i18n/localeSync'
import type { SpaceAssistantApi } from '../shared/api'
import type { AppConfig } from '../shared/domainTypes'

if (typeof window !== 'undefined') {
  const api = (window.api ?? {}) as Partial<SpaceAssistantApi>
  window.api = {
    ...api,
    usageGet: api.usageGet ?? (async () => undefined),
    usageSet: api.usageSet ?? (async () => {}),
    usageDelete: api.usageDelete ?? (async () => {}),
    windowGetPlatform: api.windowGetPlatform ?? (async () => 'win32' as const),
    windowIsMaximized: api.windowIsMaximized ?? (async () => false),
    windowMinimize: api.windowMinimize ?? (async () => {}),
    windowMaximizeToggle: api.windowMaximizeToggle ?? (async () => false),
    windowClose: api.windowClose ?? (async () => {}),
    windowOnMaximizeChanged: api.windowOnMaximizeChanged ?? (() => () => {}),
    appQuit: api.appQuit ?? (async () => {}),
    appToggleDevTools: api.appToggleDevTools ?? (async () => {}),
    workdirSwitch: api.workdirSwitch ?? (async () => ({ success: true, sessions: [] })),
    configGet: api.configGet ?? (async () => ({ workDir: '' } as AppConfig)),
    getToolExposureList: api.getToolExposureList ?? (async () => []),
    onToolExposureChanged: api.onToolExposureChanged ?? (() => () => {})
    ,skillInstallOnProgress: api.skillInstallOnProgress ?? (() => () => {})
    ,skillCancelInstall: api.skillCancelInstall ?? (async () => {})
    ,skillProbeFromUrl: api.skillProbeFromUrl ?? (async () => ({ ok: false, error: 'mock' }))
    ,skillScanStatus: api.skillScanStatus ?? (async () => ({ skills: [], skipped: [] }))
  } as SpaceAssistantApi
}

beforeEach(async () => {
  await changeAppLocale('zh-CN')
})

/** jsdom 未实现带 pseudoElt 的 getComputedStyle，antd/rc-util 会触发告警 */
if (typeof window !== 'undefined' && window.getComputedStyle) {
  const orig = window.getComputedStyle.bind(window)
  window.getComputedStyle = (elt: Element, pseudoElt?: string | null) => {
    if (pseudoElt) {
      return {
        getPropertyValue: () => ''
      } as unknown as CSSStyleDeclaration
    }
    return orig(elt)
  }
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false
  })
}

/** jsdom 不提供 canvas 2D context；xterm 只需测量和基础绘制 API 才能完成初始化。 */
if (typeof window !== 'undefined' && typeof HTMLCanvasElement !== 'undefined') {
  const canvasProto = HTMLCanvasElement.prototype as HTMLCanvasElement & {
    getContext: (contextId: string, ...args: unknown[]) => unknown
  }
  canvasProto.getContext = (contextId: string) => {
    if (contextId !== '2d') return null
    return {
      canvas: {},
      measureText: (text: string) => ({ width: text.length * 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
      fillRect() {}, clearRect() {}, strokeRect() {}, fillText() {}, strokeText() {}, drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
      putImageData() {}, createImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
      setTransform() {}, resetTransform() {}, translate() {}, scale() {}, rotate() {}, transform() {},
      save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, rect() {},
      clip() {}, fill() {}, stroke() {}, arc() {},
      globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000', strokeStyle: '#000',
      lineWidth: 1, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic'
    }
  }
}
