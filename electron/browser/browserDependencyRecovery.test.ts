import { describe, expect, it } from 'vitest'
import {
  formatDependencyRecoveryToolContent,
  resolveDependencyRecoverySkill
} from './browserDependencyRecovery'

describe('browserDependencyRecovery', () => {
  it('returns skill for chromium_missing', () => {
    expect(resolveDependencyRecoverySkill('chromium_missing')).toBe('browser-setup-guide')
  })

  it('does not trigger for stagehand_missing', () => {
    expect(resolveDependencyRecoverySkill('stagehand_missing')).toBeNull()
  })

  it('formatDependencyRecoveryToolContent is JSON with setup flag and updated message', () => {
    const text = formatDependencyRecoveryToolContent({
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
        errors: ['Chromium 未安装'],
        recommendedCwd: 'E:\\app',
        installContext: 'development'
      }
    })
    const parsed = JSON.parse(text) as { dependencySetupRequired?: boolean; message?: string }
    expect(parsed.dependencySetupRequired).toBe(true)
    expect(parsed.message).toMatch(/网络访问修复/)
  })
})
