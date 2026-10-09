import { describe, expect, it } from 'vitest'
import { getBundledImTaskOrchestrationSkill, IM_TASK_ORCHESTRATION_SKILL_NAME } from './imTaskOrchestrationSkill'
import { getSkillByName } from '../skillScanner'

describe('imTaskOrchestrationSkill', () => {
  it('provides bundled task routing and recovery policy', () => {
    const skill = getBundledImTaskOrchestrationSkill()
    expect(skill.meta.name).toBe(IM_TASK_ORCHESTRATION_SKILL_NAME)
    expect(skill.scope).toBe('builtin')
    expect(skill.content).toMatch(/复杂任务.*计划/)
    expect(skill.content).toMatch(/澄清/)
    expect(skill.content).toMatch(/workflow state/)
    expect(skill.content).toMatch(/追加到当前任务、开始新请求还是继续澄清/)
  })

  it('is available from the bundled skill scanner', () => {
    expect(getSkillByName('/tmp/user', '/tmp/work', IM_TASK_ORCHESTRATION_SKILL_NAME)?.meta.name)
      .toBe(IM_TASK_ORCHESTRATION_SKILL_NAME)
  })
})
