import { describe, expect, it } from 'vitest'
import { getRecommendedSkillAuthor, isRecommendedSkillInstalled, RECOMMENDED_SKILLS } from '../../src/shared/recommendedSkills'

describe('recommendedSkills', () => {
  it('contains the initial recommended entries', () => {
    expect(RECOMMENDED_SKILLS.map((entry) => entry.id)).toEqual([
      'superpowers',
      'guizang-social-card',
      'pptx-generator',
      'minimax-xlsx',
      'minimax-docx'
    ])
  })

  it('detects installed recommended skills by expected names', () => {
    const entry = RECOMMENDED_SKILLS[0]!
    expect(isRecommendedSkillInstalled(entry, new Set(['brainstorming']))).toBe(false)
    expect(isRecommendedSkillInstalled(entry, new Set(entry.expectedSkillNames))).toBe(true)
  })

  it('extracts author from github url', () => {
    expect(getRecommendedSkillAuthor(RECOMMENDED_SKILLS[0]!)).toBe('obra')
    expect(getRecommendedSkillAuthor(RECOMMENDED_SKILLS[3]!)).toBe('MiniMax-AI')
  })
})
