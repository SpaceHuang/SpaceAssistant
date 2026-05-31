import { describe, expect, it, vi, beforeEach } from 'vitest'
import { browserDetectExecutor } from './browserDetectExecutor'

const detectDependencies = vi.fn()
const configureDetectContext = vi.fn()

vi.mock('../browser/stagehandService', () => ({
  stagehandService: {
    detectDependencies: (...args: unknown[]) => detectDependencies(...args),
    configureDetectContext: (...args: unknown[]) => configureDetectContext(...args)
  }
}))

describe('browserDetectExecutor', () => {
  beforeEach(() => {
    detectDependencies.mockReset()
    configureDetectContext.mockReset()
  })

  it('configures detect context and returns detect result', async () => {
    const mockResult = { canInitialize: false, primaryFailure: 'chromium_missing' }
    detectDependencies.mockResolvedValue(mockResult)

    const ctx = {
      workDir: '/w',
      userDataDir: '/u',
      requestId: 'r',
      toolUseId: 't',
      sessionId: 's',
      sendProgress: vi.fn(),
      signal: new AbortController().signal,
      fileStateCache: {} as never,
      toolsConfig: { enabled: true, allowedTools: [], deniedTools: [] },
      getBrowserDetectContext: () => ({
        isPackaged: false,
        appPath: '/app',
        devRoot: '/dev'
      })
    }

    const result = await browserDetectExecutor.execute({ force: true }, ctx)

    expect(configureDetectContext).toHaveBeenCalledWith({
      isPackaged: false,
      appPath: '/app',
      devRoot: '/dev'
    })
    expect(detectDependencies).toHaveBeenCalledWith(true)
    expect(result.success).toBe(true)
    expect(result.data).toEqual(mockResult)
  })
})
