import { describe, expect, it, vi } from 'vitest'
import { createDeferredStagehandClose } from './startupDeferredModules'

describe('createDeferredStagehandClose', () => {
  it('loads the browser automation service only when shutdown runs', async () => {
    const closeAll = vi.fn(async () => undefined)
    const load = vi.fn(async () => ({ stagehandService: { closeAll } }))

    const close = createDeferredStagehandClose(load)
    expect(load).not.toHaveBeenCalled()

    await close()

    expect(load).toHaveBeenCalledTimes(1)
    expect(closeAll).toHaveBeenCalledTimes(1)
  })
})
