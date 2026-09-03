import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  refreshToolExposure,
  initToolExposure,
  subscribeToolExposure,
  getCachedToolExposure,
  resetToolExposureForTests
} from './toolExposureService'

describe('toolExposureService（渲染端 exposure 清单缓存）', () => {
  let pushHandler: ((payload: { lane: string; tools: string[] }) => void) | null

  beforeEach(() => {
    resetToolExposureForTests()
    pushHandler = null
    ;(window as unknown as { api: unknown }).api = {
      getToolExposureList: vi.fn(async () => ['read_file', 'write_file']),
      onToolExposureChanged: vi.fn((cb: (payload: { lane: string; tools: string[] }) => void) => {
        pushHandler = cb
        return () => undefined
      })
    }
  })

  it('refresh 后缓存主进程清单，可被薄壳消费（不上行 config）', async () => {
    const list = await refreshToolExposure()
    expect(list).toEqual(['read_file', 'write_file'])
    expect(getCachedToolExposure()).toEqual(['read_file', 'write_file'])
    expect(
      (window as unknown as { api: { getToolExposureList: ReturnType<typeof vi.fn> } }).api
        .getToolExposureList
    ).toHaveBeenCalledWith({ lane: 'desktop' })
  })

  it('未 refresh 时缓存为 null（冷启动空窗，调用方不渲染工具列表）', () => {
    expect(getCachedToolExposure()).toBeNull()
  })

  it('init：挂载即拉一次全量清单并订阅重推', async () => {
    const seen: Array<string[] | null> = []
    const unsub = subscribeToolExposure((tools) => seen.push(tools))
    const off = initToolExposure()
    expect(
      (window as unknown as { api: { onToolExposureChanged: ReturnType<typeof vi.fn> } }).api
        .onToolExposureChanged
    ).toHaveBeenCalled()
    await vi.waitFor(() => expect(getCachedToolExposure()).toEqual(['read_file', 'write_file']))
    expect(seen.at(-1)).toEqual(['read_file', 'write_file'])
    unsub()
    off()
  })

  it('配置变更重推：推送到达即更新缓存并通知订阅者', async () => {
    await refreshToolExposure()
    const seen: Array<string[] | null> = []
    subscribeToolExposure((tools) => seen.push(tools))
    initToolExposure()
    pushHandler!({ lane: 'desktop', tools: ['read_file'] })
    expect(getCachedToolExposure()).toEqual(['read_file'])
    expect(seen.at(-1)).toEqual(['read_file'])
    // 非桌面链路的推送不影响渲染端缓存
    pushHandler!({ lane: 'wechat', tools: [] })
    expect(getCachedToolExposure()).toEqual(['read_file'])
  })
})
