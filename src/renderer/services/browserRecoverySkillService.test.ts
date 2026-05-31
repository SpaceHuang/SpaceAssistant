import { describe, expect, it, vi, beforeEach } from 'vitest'
import { activateBrowserRecoverySkillIfNeeded } from './browserRecoverySkillService'
import type { BrowserDependencyToolError } from '../../shared/browserTypes'

const recovery: BrowserDependencyToolError = {
  errorCode: 'chromium_missing',
  errorMessage: 'missing',
  recommendedCwd: 'E:\\app',
  installCommand: 'npx playwright install chromium',
  detectResult: {
    stagehand: { installed: true },
    playwright: { installed: true, browsers: [] },
    chromium: { ready: false },
    node: { version: 'v22', meetsRequirement: true },
    canInitialize: false,
    primaryFailure: 'chromium_missing',
    errors: [],
    recommendedCwd: 'E:\\app',
    installContext: 'development'
  }
}

describe('browserRecoverySkillService', () => {
  beforeEach(() => {
    window.api = {
      ...window.api,
      sessionGet: vi.fn().mockResolvedValue({
        id: 's1',
        skillsState: { manualActivated: [], manualDisabled: [] }
      }),
      sessionUpdate: vi.fn().mockResolvedValue({
        id: 's1',
        skillsState: { manualActivated: ['browser-setup-guide'], manualDisabled: [] }
      })
    } as typeof window.api
  })

  it('activates skill when dependency recovery hits whitelist', async () => {
    const result = await activateBrowserRecoverySkillIfNeeded({
      dependencyRecovery: recovery,
      sessionId: 's1',
      currentSkillsState: { manualActivated: [], manualDisabled: [] }
    })
    expect(result.activated).toBe(true)
    expect(window.api.sessionUpdate).toHaveBeenCalled()
    expect(result.hint).toMatch(/browser-setup-guide/)
    expect(result.hint).toMatch(/依赖恢复/)
  })

  it('skips when skill already activated in session store', async () => {
    vi.mocked(window.api.sessionGet).mockResolvedValue({
      id: 's1',
      skillsState: { manualActivated: ['browser-setup-guide'], manualDisabled: [] }
    } as never)
    const result = await activateBrowserRecoverySkillIfNeeded({
      dependencyRecovery: recovery,
      sessionId: 's1',
      currentSkillsState: { manualActivated: [], manualDisabled: [] }
    })
    expect(result.activated).toBe(false)
    expect(window.api.sessionUpdate).not.toHaveBeenCalled()
  })
})
