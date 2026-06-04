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
