import { describe, expect, it } from 'vitest'
import { buildPlanApprovalSummary, countPlanSteps, parsePlanMarkdown } from './planParser'

const SAMPLE = `---
plan_id: plan-1
version: 1
steps_total: 2
---

# 计划：示例功能

## 1. 目标
实现 X。

## 3. 推荐方案
采用 Y 方案。

## 4. 执行步骤
- [ ] 步骤一
- [ ] 步骤二

## 6. 验收标准
- [ ] 测试通过

## 7. 风险与注意事项
- 风险 A
`

describe('parsePlanMarkdown', () => {
  it('parses frontmatter and steps', () => {
    const p = parsePlanMarkdown(SAMPLE)
    expect(p.frontmatter.plan_id).toBe('plan-1')
    expect(p.title).toContain('示例功能')
    expect(p.steps).toHaveLength(2)
  })

  it('builds approval summary', () => {
    const s = buildPlanApprovalSummary(SAMPLE)
    expect(s.stepCount).toBe(2)
    expect(s.acceptanceCriteria.length).toBeGreaterThan(0)
    expect(s.title).toContain('示例功能')
  })

  it('counts steps', () => {
    expect(countPlanSteps(SAMPLE)).toBe(2)
  })

  it('warns on placeholders in key fields', () => {
    const bad = SAMPLE.replace('实现 X', 'TODO 待定')
    const s = buildPlanApprovalSummary(bad)
    expect(s.placeholderWarnings.length).toBeGreaterThan(0)
  })
})
