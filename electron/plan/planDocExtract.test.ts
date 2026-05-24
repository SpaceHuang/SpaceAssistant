import { describe, expect, it } from 'vitest'
import { extractPlanMarkersFromText } from './planDocExtract'

describe('extractPlanMarkersFromText', () => {
  it('extracts plan-doc block', () => {
    const r = extractPlanMarkersFromText('intro\n<plan-doc>\n# Title\n</plan-doc>\n')
    expect(r.kind).toBe('plan-doc')
    if (r.kind === 'plan-doc') expect(r.content).toContain('# Title')
  })

  it('extracts plan-abort block', () => {
    const r = extractPlanMarkersFromText('<plan-abort>任务过于简单</plan-abort>')
    expect(r.kind).toBe('plan-abort')
    if (r.kind === 'plan-abort') expect(r.content).toContain('过于简单')
  })

  it('prefers plan-abort over plan-doc', () => {
    const r = extractPlanMarkersFromText('<plan-abort>x</plan-abort><plan-doc>y</plan-doc>')
    expect(r.kind).toBe('plan-abort')
  })

  it('returns none when no markers', () => {
    expect(extractPlanMarkersFromText('hello').kind).toBe('none')
  })

  it('detects plan markdown with frontmatter and goal section without tags', () => {
    const md = `---
plan_id: p1
version: 1
---

# 计划：测试

## 1. 目标
完成某功能。`
    const r = extractPlanMarkersFromText(md)
    expect(r.kind).toBe('plan-doc')
    if (r.kind === 'plan-doc') expect(r.content).toContain('## 1. 目标')
  })

  it('detects ## 目标 heading without section number', () => {
    const md = `---
plan_id: p2
---

# 计划

## 目标
描述。`
    expect(extractPlanMarkersFromText(md).kind).toBe('plan-doc')
  })
})
