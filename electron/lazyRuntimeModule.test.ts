import { createLazyRuntimeModule } from './lazyRuntimeModule'

describe('createLazyRuntimeModule', () => {
  it('loads on first use and reuses the loaded runtime module', () => {
    const runtime = { parse: vi.fn() }
    const load = vi.fn(() => runtime)
    const getRuntime = createLazyRuntimeModule(load)

    expect(load).not.toHaveBeenCalled()
    expect(getRuntime()).toBe(runtime)
    expect(getRuntime()).toBe(runtime)
    expect(load).toHaveBeenCalledTimes(1)
  })
})
