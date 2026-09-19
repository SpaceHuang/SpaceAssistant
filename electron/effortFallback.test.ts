import { afterEach, describe, expect, it } from 'vitest'
import {
  buildThinkingWireParams,
  consumeEffortMemoizedAudit,
  effortMemoKey,
  isEffortUnsupportedByUpstream,
  isOutputConfigRejectedError,
  memoizeEffortUnsupported,
  resetEffortMemoForTests
} from './effortFallback'

afterEach(() => {
  resetEffortMemoForTests()
})

describe('buildThinkingWireParams（§7.3 档位映射表）', () => {
  it('off → disabled thinking，且不附 output_config', () => {
    expect(buildThinkingWireParams('off')).toEqual({ thinking: { type: 'disabled' } })
    expect(buildThinkingWireParams('off').outputConfig).toBeUndefined()
  })

  it('low / medium / high → adaptive thinking + output_config.effort（同发，官方迁移写法）', () => {
    expect(buildThinkingWireParams('low')).toEqual({
      thinking: { type: 'adaptive' },
      outputConfig: { effort: 'low' }
    })
    expect(buildThinkingWireParams('medium')).toEqual({
      thinking: { type: 'adaptive' },
      outputConfig: { effort: 'medium' }
    })
    expect(buildThinkingWireParams('high')).toEqual({
      thinking: { type: 'adaptive' },
      outputConfig: { effort: 'high' }
    })
  })

  it('low 与 high 的 wire 产物不相等（档位不被折叠，§10.3）', () => {
    expect(JSON.stringify(buildThinkingWireParams('low'))).not.toBe(JSON.stringify(buildThinkingWireParams('high')))
  })
})

describe('isOutputConfigRejectedError', () => {
  it('matches a 400 unknown-field rejection mentioning output_config', () => {
    const err = Object.assign(new Error('output_config: Extra inputs are not permitted'), { status: 400 })
    expect(isOutputConfigRejectedError(err)).toBe(true)
  })

  it('does not match other 400s (真实参数错误不得被掩盖，§7.4)', () => {
    const err = Object.assign(new Error('max_tokens: greater than context window'), { status: 400 })
    expect(isOutputConfigRejectedError(err)).toBe(false)
  })

  it('does not match auth / not-found / rate-limit errors (fail-fast 语义保留)', () => {
    expect(isOutputConfigRejectedError(Object.assign(new Error('invalid x-api-key'), { status: 401 }))).toBe(false)
    expect(isOutputConfigRejectedError(Object.assign(new Error('output_config rejected'), { status: 404 }))).toBe(false)
    expect(isOutputConfigRejectedError(Object.assign(new Error('output_config rejected'), { status: 429 }))).toBe(false)
    expect(isOutputConfigRejectedError(new Error('output_config rejected (no status)'))).toBe(false)
    expect(isOutputConfigRejectedError('output_config string error')).toBe(false)
  })
})

describe('进程内降级记忆（OQ-6：粒度 = llmServiceId + model）', () => {
  it('memo key combines service id and model (同服务其他模型不受连坐)', () => {
    expect(effortMemoKey('svc-a', 'model-1')).toBe('svc-a|model-1')
    expect(effortMemoKey(undefined, 'model-1')).toBe('|model-1')
    expect(effortMemoKey('svc-a', 'model-1')).not.toBe(effortMemoKey('svc-a', 'model-2'))
    expect(effortMemoKey('svc-a', 'model-1')).not.toBe(effortMemoKey('svc-b', 'model-1'))
  })

  it('memoized service+model reports unsupported; others stay clean', () => {
    expect(isEffortUnsupportedByUpstream('svc-a', 'model-1')).toBe(false)
    memoizeEffortUnsupported('svc-a', 'model-1')
    expect(isEffortUnsupportedByUpstream('svc-a', 'model-1')).toBe(true)
    // 同服务其他模型、其他服务同模型均不受影响（C1 评审结论）
    expect(isEffortUnsupportedByUpstream('svc-a', 'model-2')).toBe(false)
    expect(isEffortUnsupportedByUpstream('svc-b', 'model-1')).toBe(false)
    expect(isEffortUnsupportedByUpstream(undefined, 'model-1')).toBe(false)
  })

  it('reset clears the memo（进程重启即清空的测试等价物）', () => {
    memoizeEffortUnsupported('svc-a', 'model-1')
    resetEffortMemoForTests()
    expect(isEffortUnsupportedByUpstream('svc-a', 'model-1')).toBe(false)
  })

  it('memoized-skip audit fires exactly once per service+model（llm.effort.unsupported_memoized 只落一次）', () => {
    memoizeEffortUnsupported('svc-a', 'model-1')
    expect(consumeEffortMemoizedAudit('svc-a', 'model-1')).toBe(true)
    expect(consumeEffortMemoizedAudit('svc-a', 'model-1')).toBe(false)
    // 未命中记忆的 key 不应产出审计
    expect(consumeEffortMemoizedAudit('svc-a', 'model-2')).toBe(false)
  })
})
