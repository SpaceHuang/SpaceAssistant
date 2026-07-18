import { describe, expect, it } from 'vitest'
import { resolveArtifactBadgeLabel } from './WriteSuccessCard'

describe('WriteSuccessCard', () => {
  const t = (key: string) => key

  it('shows container badge and finalPath from artifact metadata', () => {
    expect(resolveArtifactBadgeLabel({ container: 'project', role: 'primary', finalPath: 'src/auth.ts' }, t)).toBe(
      'writeSuccess.badgeProject'
    )
    expect(resolveArtifactBadgeLabel({ container: 'package', role: 'primary', finalPath: 'report.md' }, t)).toBe(
      'writeSuccess.badgePackage'
    )
    expect(resolveArtifactBadgeLabel({ container: 'scratch', role: 'scratch', finalPath: 'run.sh' }, t)).toBe(
      'writeSuccess.badgeScratch'
    )
  })
})
