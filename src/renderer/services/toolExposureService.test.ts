import { beforeEach, describe, expect, it } from 'vitest'
import {
  refreshToolExposure,
  getCachedToolExposure,
  resetToolExposureForTests
} from './toolExposureService'

describe('toolExposureService（渲染端 exposure 清单缓存）', () => {
  beforeEach(() => {
    resetToolExposureForTests()
    ;(window as unknown as { api: unknown }).api = {
      getToolExposureList: async () => ['read_file', 'write_file']
    }
  })

  it('refresh 后缓存主进程清单，可被薄壳消费', async () => {
    const list = await refreshToolExposure('desktop', {} as never)
    expect(list).toEqual(['read_file', 'write_file'])
    expect(getCachedToolExposure()).toEqual(['read_file', 'write_file'])
  })

  it('未 refresh 时缓存为 null（回退旧滤镜）', () => {
    expect(getCachedToolExposure()).toBeNull()
  })
})
