import { describe, expect, it } from 'vitest'
import { turnDisplayStore } from '../services/turnDisplayStore'
import { useTurnDisplay } from './useTurnDisplay'

describe('useTurnDisplay', () => {
  it('提供稳定的 bounded display store 订阅入口', () => {
    expect(typeof useTurnDisplay).toBe('function')
    turnDisplayStore.clear()
  })
})
