import { describe, expect, it } from 'vitest'
import type { ExecutionLane, PolicyAction, PolicyPackage } from '../confirmation/types'
import { LANE_PROFILES, effectiveActionFor } from './policyPackages'

/** 全部基线动作（§2.1 变换表的输入域）。 */
const BASELINE_ACTIONS: PolicyAction[] = ['deny', 'allow', 'ask', 'auto-evaluator', 'confirm-every-time']

const ALL_LANES: ExecutionLane[] = ['desktop', 'wechat', 'feishu', 'automation']

/**
 * §2.1 档位变换期望矩阵（S1，偏差 15：strict / loose 已范围化，不再做宽严变换——
 * 映射表仅剩 desktop standard 的「自动」路径映射；locked/deny/confirm-every-time 例外另测；
 * custom 档是用户显式覆盖，不经变换表改写（恒等）。
 */
const EXPECTED: Record<ExecutionLane, Record<PolicyPackage, Partial<Record<PolicyAction, PolicyAction>>>> = {
  desktop: {
    strict: {},
    standard: { ask: 'auto-evaluator' },
    loose: {},
    custom: {}
  },
  wechat: {
    strict: {},
    standard: {},
    loose: {},
    custom: {}
  },
  feishu: {
    strict: {},
    standard: {},
    loose: {},
    custom: {}
  },
  // automation 仅提供 standard 且恒等（其唯一 ask 为 locked；回答者=agent 由 lane 派生，等价现状）
  automation: { standard: {}, strict: {}, loose: {}, custom: {} }
}

describe('LANE_PROFILES（§2.1 链路档位表）', () => {
  it('档位可用性：automation 仅 standard 且不可用户选；其余 lane 四档全开', () => {
    expect(LANE_PROFILES.automation.availablePackages).toEqual(['standard'])
    expect(LANE_PROFILES.automation.userSelectable).toBe(false)
    for (const lane of ['desktop', 'wechat', 'feishu'] as const) {
      expect(LANE_PROFILES[lane].availablePackages).toEqual(['strict', 'standard', 'loose', 'custom'])
      expect(LANE_PROFILES[lane].userSelectable).toBe(true)
    }
  })

  it('custom 可编辑动作域：desktop 4 态、wechat/feishu 3 态、automation 无可编辑档（B2）', () => {
    expect(LANE_PROFILES.desktop.availableActions).toEqual(['deny', 'allow', 'ask', 'auto-evaluator'])
    expect(LANE_PROFILES.wechat.availableActions).toEqual(['deny', 'allow', 'ask'])
    expect(LANE_PROFILES.feishu.availableActions).toEqual(['deny', 'allow', 'ask'])
    expect(LANE_PROFILES.automation.availableActions).toEqual([])
  })

  for (const lane of ALL_LANES) {
    describe(`档位变换逐格：${lane}`, () => {
      for (const pkg of ['strict', 'standard', 'loose', 'custom'] as const) {
        it(`${lane} × ${pkg}`, () => {
          for (const baseline of BASELINE_ACTIONS) {
            const expected = EXPECTED[lane][pkg][baseline] ?? baseline
            expect(effectiveActionFor(lane, pkg, { action: baseline })).toBe(expected)
          }
        })
      }
    })

    it(`${lane}：locked 条目任何档位都不变换（B1，不可变换集）`, () => {
      for (const pkg of ['strict', 'standard', 'loose', 'custom'] as const) {
        for (const baseline of BASELINE_ACTIONS) {
          expect(effectiveActionFor(lane, pkg, { action: baseline, locked: true })).toBe(baseline)
        }
      }
    })
  }

  it('不可变换集：deny 与 confirm-every-time 在任何 lane × 档位都保持原动作', () => {
    for (const lane of ALL_LANES) {
      for (const pkg of ['strict', 'standard', 'loose', 'custom'] as const) {
        expect(effectiveActionFor(lane, pkg, { action: 'deny' })).toBe('deny')
        expect(effectiveActionFor(lane, pkg, { action: 'confirm-every-time' })).toBe('confirm-every-time')
      }
    }
  })
})
