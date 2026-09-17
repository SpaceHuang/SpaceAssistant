import { describe, expect, it } from 'vitest'
import { getBundledBrowserSetupGuideSkill, BROWSER_SETUP_GUIDE_SKILL_NAME } from './browserSetupGuideSkill'
import { getSkillByName } from '../skillScanner'

describe('browserSetupGuideSkill', () => {
  it('loads bundled skill with expected name', () => {
    const skill = getBundledBrowserSetupGuideSkill()
    expect(skill.meta.name).toBe(BROWSER_SETUP_GUIDE_SKILL_NAME)
    expect(skill.scope).toBe('builtin')
    expect(skill.content).toMatch(/env\.browserDetect/)  // browser_detect 已收编为 env.browserDetect 能力
    expect(skill.content).toMatch(/run_shell/)
    expect(skill.content).not.toMatch(/MVP 引导用户手动在终端执行/)
    expect(skill.content).toMatch(/优先用 `run_shell` 代为安装/)
  })

  it('is available via skillScanner getSkillByName', () => {
    const skill = getSkillByName('/tmp/user', '/tmp/work', BROWSER_SETUP_GUIDE_SKILL_NAME)
    expect(skill?.meta.name).toBe(BROWSER_SETUP_GUIDE_SKILL_NAME)
  })
})
