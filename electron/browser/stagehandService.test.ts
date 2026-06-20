import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BROWSER_CONFIG } from '../../src/shared/domainTypes'

const mockInit = vi.fn().mockResolvedValue(undefined)
const mockClose = vi.fn().mockResolvedValue(undefined)
const mockGoto = vi.fn().mockResolvedValue(undefined)
const mockPages = vi.fn().mockReturnValue([{ goto: mockGoto }])

const { mockBrowserHostClose } = vi.hoisted(() => ({
  mockBrowserHostClose: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./playwrightBrowserHost', () => ({
  launchPlaywrightBrowserHost: vi.fn().mockResolvedValue({
    cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/mock',
    close: mockBrowserHostClose
  })
}))

vi.mock('../esmDynamicImport', () => ({
  importEsmModule: vi.fn().mockImplementation(async () => {
    const { Stagehand } = await import('@browserbasehq/stagehand')
    return { Stagehand }
  })
}))

vi.mock('@browserbasehq/stagehand', () => {
  class Stagehand {
    init = mockInit
    close = mockClose
    observe = vi.fn()
    extract = vi.fn()
    act = vi.fn()
    context = {
      pages: mockPages
    }
    constructor(_opts: Record<string, unknown>) {}
  }
  return { Stagehand }
})

import { StagehandService } from './stagehandService'

describe('StagehandService', () => {
  let svc: StagehandService

  beforeEach(() => {
    vi.clearAllMocks()
    mockInit.mockResolvedValue(undefined)
    svc = new StagehandService()
    svc.configureDetectContext({
      isPackaged: false,
      appPath: process.cwd(),
      devRoot: process.cwd()
    })
  })

  afterEach(async () => {
    await svc.closeAll()
  })

  const creds = {
    model: { modelName: 'anthropic/claude-sonnet-4-6', apiKey: 'sk-test' }
  }

  it('getOrCreate creates instance once per session', async () => {
    await svc.getOrCreate('s1', DEFAULT_BROWSER_CONFIG, creds)
    await svc.getOrCreate('s1', DEFAULT_BROWSER_CONFIG, creds)
    expect(mockInit).toHaveBeenCalledTimes(1)
  })

  it('closeSession removes instance', async () => {
    await svc.getOrCreate('s2', DEFAULT_BROWSER_CONFIG, creds)
    await svc.closeSession('s2')
    expect(mockClose).toHaveBeenCalled()
    expect(mockBrowserHostClose).toHaveBeenCalled()
    mockInit.mockClear()
    await svc.getOrCreate('s2', DEFAULT_BROWSER_CONFIG, creds)
    expect(mockInit).toHaveBeenCalledTimes(1)
  })

  it('closeSession on missing id does not throw', async () => {
    await expect(svc.closeSession('missing')).resolves.toBeUndefined()
  })

  it('incrementAndCheck enforces quota', () => {
    svc.resetInferenceCount('q1')
    for (let i = 0; i < 8; i++) svc.incrementAndCheck('q1', 8)
    expect(() => svc.incrementAndCheck('q1', 8)).toThrow(/推理次数已达上限/)
  })

  it('resetInferenceCount clears quota', () => {
    svc.resetInferenceCount('q2')
    for (let i = 0; i < 8; i++) svc.incrementAndCheck('q2', 8)
    svc.resetInferenceCount('q2')
    expect(() => svc.incrementAndCheck('q2', 8)).not.toThrow()
  })

  it('different sessions have independent quotas', () => {
    svc.resetInferenceCount('a')
    svc.resetInferenceCount('b')
    for (let i = 0; i < 8; i++) svc.incrementAndCheck('a', 8)
    expect(() => svc.incrementAndCheck('b', 8)).not.toThrow()
  })

  it('init failure throws user-facing message without raw error', async () => {
    mockInit.mockRejectedValueOnce(new Error('boom'))
    try {
      await svc.getOrCreate('fail', DEFAULT_BROWSER_CONFIG, creds)
      expect.fail('expected throw')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      expect(msg).toMatch(/浏览器初始化失败/)
      expect(msg).not.toContain('boom')
    }
  })

  it('detectDependencies returns structure', async () => {
    const r = await svc.detectDependencies()
    expect(r.stagehand.installed).toBe(true)
    expect(r.node.meetsRequirement).toBe(true)
    expect(r.primaryFailure).toBeDefined()
    expect(r.chromium).toBeDefined()
    expect(r.recommendedCwd).toBeTruthy()
    expect(r.installContext).toMatch(/development|packaged/)
  })

  it('peekCurrentUrl returns undefined when session missing', () => {
    expect(svc.peekCurrentUrl('missing')).toBeUndefined()
  })

  it('peekCurrentUrl returns page url when session exists', async () => {
    const mockUrl = vi.fn().mockReturnValue('https://github.com/foo')
    mockPages.mockReturnValue([{ goto: mockGoto, url: mockUrl }])
    await svc.getOrCreate('peek-s', DEFAULT_BROWSER_CONFIG, creds)
    expect(svc.peekCurrentUrl('peek-s')).toBe('https://github.com/foo')
  })

  it('peekCurrentUrl returns undefined when no pages', async () => {
    mockPages.mockReturnValue([])
    await svc.getOrCreate('peek-empty', DEFAULT_BROWSER_CONFIG, creds)
    expect(svc.peekCurrentUrl('peek-empty')).toBeUndefined()
  })
})
