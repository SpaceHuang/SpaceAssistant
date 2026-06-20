import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_BROWSER_CONFIG } from '../../src/shared/domainTypes'
import {
  assessActDanger,
  elementEffectToUserReason,
  isDangerousElementEffect,
  pageEffectToUserReason
} from './actDangerAssessor'
import type { StagehandService } from './stagehandService'

function mockStagehand(overrides: Partial<StagehandService> = {}): StagehandService {
  return {
    scanPageEffect: vi.fn().mockResolvedValue({ hasDangerousControl: false, signals: [] }),
    observeActCandidates: vi.fn().mockResolvedValue([]),
    resolveCandidateEffect: vi.fn().mockResolvedValue(null),
    ...overrides
  } as unknown as StagehandService
}

describe('assessActDanger', () => {
  it('keyword hit returns source=keyword and money consequence', async () => {
    const result = await assessActDanger(
      's1',
      { instruction: '点击提交订单' },
      DEFAULT_BROWSER_CONFIG,
      mockStagehand()
    )
    expect(result.dangerous).toBe(true)
    expect(result.source).toBe('keyword')
    expect(result.consequence).toBe('money')
    expect(result.userReason).toContain('提交订单')
  })

  it('L-1 miss returns safe without observe', async () => {
    const stagehand = mockStagehand()
    const result = await assessActDanger(
      's1',
      { instruction: '点击下一页' },
      DEFAULT_BROWSER_CONFIG,
      stagehand
    )
    expect(result.dangerous).toBe(false)
    expect(stagehand.observeActCandidates).not.toHaveBeenCalled()
  })

  it('L-1 hit triggers observe and L-2 hit returns target-effect', async () => {
    const stagehand = mockStagehand({
      scanPageEffect: vi.fn().mockResolvedValue({
        hasDangerousControl: true,
        signals: ['危险按钮: submit']
      }),
      observeActCandidates: vi.fn().mockResolvedValue([{ selector: '#pay', method: 'click' }]),
      resolveCandidateEffect: vi.fn().mockResolvedValue({
        hit: true,
        summary: '跳转到其他网站 pay.example.com',
        consequence: 'unknown-site'
      })
    })
    const result = await assessActDanger(
      's1',
      { instruction: '点击下一页' },
      DEFAULT_BROWSER_CONFIG,
      stagehand
    )
    expect(result.dangerous).toBe(true)
    expect(result.source).toBe('target-effect')
    expect(stagehand.observeActCandidates).toHaveBeenCalled()
  })

  it('L-1 hit but L-2 safe returns non-dangerous', async () => {
    const stagehand = mockStagehand({
      scanPageEffect: vi.fn().mockResolvedValue({
        hasDangerousControl: true,
        signals: ['危险按钮: submit']
      }),
      observeActCandidates: vi.fn().mockResolvedValue([{ selector: '#next' }]),
      resolveCandidateEffect: vi.fn().mockResolvedValue(null)
    })
    const result = await assessActDanger(
      's1',
      { instruction: '点击下一页' },
      DEFAULT_BROWSER_CONFIG,
      stagehand
    )
    expect(result.dangerous).toBe(false)
  })

  it('L-1 hit but observe throws returns conservative page-effect danger', async () => {
    const stagehand = mockStagehand({
      scanPageEffect: vi.fn().mockResolvedValue({
        hasDangerousControl: true,
        signals: ['危险按钮: submit']
      }),
      observeActCandidates: vi.fn().mockRejectedValue(new Error('timeout'))
    })
    const result = await assessActDanger(
      's1',
      { instruction: '点击下一页' },
      DEFAULT_BROWSER_CONFIG,
      stagehand
    )
    expect(result.dangerous).toBe(true)
    expect(result.source).toBe('page-effect')
  })

  it('scanPageEffect throw returns safe', async () => {
    const stagehand = mockStagehand({
      scanPageEffect: vi.fn().mockRejectedValue(new Error('no page'))
    })
    const result = await assessActDanger(
      's1',
      { instruction: '点击' },
      DEFAULT_BROWSER_CONFIG,
      stagehand
    )
    expect(result.dangerous).toBe(false)
  })

  it('userReason avoids developer jargon', () => {
    const reason = elementEffectToUserReason(
      { href: 'https://pay.example.com/x', formAction: '', label: '', type: '' },
      'https://shop.example.com'
    )
    expect(reason).toContain('pay.example.com')
    expect(reason).not.toMatch(/method=|action=|跨域/)
    const pageReason = pageEffectToUserReason({
      hasDangerousControl: true,
      signals: ['跨域链接: Pay → pay.example.com']
    })
    expect(pageReason).not.toContain('跨域')
  })
})

describe('isDangerousElementEffect', () => {
  it('detects cross-origin href', () => {
    expect(
      isDangerousElementEffect(
        { href: 'https://evil.com', formAction: '', label: '', type: '' },
        'https://safe.com/page'
      )
    ).toBe(true)
  })
})
