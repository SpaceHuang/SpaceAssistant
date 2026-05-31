import { describe, expect, it, vi } from 'vitest'
import {
  formatDependencyRecoveryToolContent,
  resolveDependencyRecoverySkill
} from './browser/browserDependencyRecovery'

describe('toolChatLoop dependency recovery integration', () => {
  it('recovery skill resolves for chromium errors only', () => {
    expect(resolveDependencyRecoverySkill('chromium_headless_only')).toBe('browser-setup-guide')
    expect(resolveDependencyRecoverySkill('playwright_missing')).toBeNull()
  })

  it('recovery payload guides agent without raw stack', () => {
    const content = formatDependencyRecoveryToolContent({
      errorCode: 'chromium_missing',
      errorMessage: 'Chromium 未安装',
      recommendedCwd: 'E:\\app',
      installCommand: 'npx playwright install chromium',
      detectResult: {
        stagehand: { installed: true },
        playwright: { installed: true, browsers: ['chromium'] },
        chromium: { ready: false },
        node: { version: 'v22', meetsRequirement: true },
        canInitialize: false,
        primaryFailure: 'chromium_missing',
        errors: [],
        recommendedCwd: 'E:\\app',
        installContext: 'development'
      }
    })
    const parsed = JSON.parse(content) as { message: string; dependencySetupRequired: boolean }
    expect(parsed.dependencySetupRequired).toBe(true)
    expect(parsed.message).toMatch(/网络访问修复/)
    expect(parsed.message).not.toMatch(/node_modules/)
  })
})
