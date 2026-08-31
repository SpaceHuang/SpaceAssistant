import { describe, expect, it } from 'vitest'
import { confirmCardPayload } from './confirmCardPayload'

describe('confirmCardPayload（P3 确认卡片数据契约）', () => {
  it('映射 require-confirm 为卡片数据（facts/风险/记忆档位编号）', () => {
    const payload = confirmCardPayload({
      type: 'require-confirm',
      ruleId: 'im-write-ask',
      riskLevel: 'medium',
      facts: {
        toolName: 'write_file',
        actionClass: 'write',
        baseRiskLevel: 'medium',
        signals: [{ kind: 'path-target', path: 'a.txt', zone: 'workdir-normal' }],
        summary: { text: '目标路径：a.txt' }
      },
      memoryTiers: [{ key: { kind: 'path', path: 'a.txt', level: 'file' }, label: '记住 a.txt' }],
      timeoutMs: null
    })
    expect(payload.toolName).toBe('write_file')
    expect(payload.riskLevel).toBe('medium')
    expect(payload.factsSummary).toBe('目标路径：a.txt')
    expect(payload.memoryTiers).toEqual([{ label: '记住 a.txt', tier: 1 }])
    expect(payload.signals).toContain('path-target')
  })
})
