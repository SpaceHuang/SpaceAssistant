import { describe, expect, it } from 'vitest'
import {
  accumulateDeferredDimension,
  emptyTurnToolDimension,
  estimateDeferredSavings,
  type TurnToolDimension
} from './usageAttribution'

/**
 * FR8：延迟加载计量维度（加性字段）——turn 维度新增 deferredToolCount / 延迟索引字符数，
 * 节省量 = eager 等效 toolsTokens − 实际 toolsTokens − 索引 token（按轮累计）。
 */

describe('FR8：deferred 计量维度（usageAttribution 加性字段）', () => {
  it('空维度无 deferred 字段（读取侧容忍缺失，向后兼容）', () => {
    const dim = emptyTurnToolDimension()
    expect(dim.deferred).toBeUndefined()
  })

  it('accumulateDeferredDimension 累加（多轮请求重复计入，与工具声明口径一致）', () => {
    const dim: TurnToolDimension = emptyTurnToolDimension()
    accumulateDeferredDimension(dim, { toolCount: 90, indexChars: 8000, eagerEquivalentChars: 160_000 })
    accumulateDeferredDimension(dim, { toolCount: 90, indexChars: 8200, eagerEquivalentChars: 160_000 })
    expect(dim.deferred).toEqual({
      toolCount: 90,
      indexChars: 16_200,
      eagerEquivalentChars: 320_000
    })
  })

  it('未启用延迟（deferred 0 工具）不产生字段', () => {
    const dim: TurnToolDimension = emptyTurnToolDimension()
    accumulateDeferredDimension(dim, { toolCount: 0, indexChars: 0, eagerEquivalentChars: 0 })
    expect(dim.deferred).toBeUndefined()
  })

  it('estimateDeferredSavings：eager 等效 token − 索引 token（chars÷3.5 口径，O9）', () => {
    // 160_000 chars eager ≈ 45_715 tokens；8_000 chars 索引 ≈ 2_286 tokens
    const savings = estimateDeferredSavings({ toolCount: 90, indexChars: 8_000, eagerEquivalentChars: 160_000 })
    expect(savings.eagerEquivalentTokens).toBe(Math.ceil(160_000 / 3.5))
    expect(savings.indexTokens).toBe(Math.ceil(8_000 / 3.5))
    expect(savings.savedTokens).toBe(Math.ceil(160_000 / 3.5) - Math.ceil(8_000 / 3.5))
  })

  it('estimateDeferredSavings 对空/负值安全', () => {
    expect(estimateDeferredSavings(undefined).savedTokens).toBe(0)
    expect(estimateDeferredSavings({ toolCount: 0, indexChars: 0, eagerEquivalentChars: 0 }).savedTokens).toBe(0)
  })
})
