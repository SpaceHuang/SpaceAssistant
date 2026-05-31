import { describe, expect, it } from 'vitest'
import { getBundledShellSetupGuideSkill } from './shellSetupGuideSkill'

describe('shellSetupGuideSkill', () => {
  it('loads bundled skill', () => {
    const skill = getBundledShellSetupGuideSkill()
    expect(skill.meta.name).toBe('shell-setup-guide')
    expect(skill.content).toMatch(/run_shell/)
  })
})
