import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RETENTION_POLICY,
  RETENTION_POLICY_CONFIG_KEYS,
  resolveRetentionPolicy,
  type RetentionPolicyConfigReader
} from './retentionPolicy'

/**
 * S3(偏差 14+24):统一保留策略归位 Storage——
 * 策略参数可配、显式默认(缺配置 = 显式声明的默认,不是代码散落的常量兜底)、
 * 非法配置 fail-closed 收敛默认。
 */

function readerWith(values: Record<string, string>): RetentionPolicyConfigReader {
  return { getConfigValue: (key: string) => values[key] }
}

describe('retentionPolicy(S3 统一保留策略)', () => {
  it('策略键可枚举且与显式默认一一对应', () => {
    expect(Object.keys(RETENTION_POLICY_CONFIG_KEYS).sort()).toEqual(
      Object.keys(DEFAULT_RETENTION_POLICY).sort()
    )
  })

  it('缺配置 → 显式默认(不是 undefined / 零值兜底)', () => {
    const policy = resolveRetentionPolicy(readerWith({}))
    expect(policy).toEqual(DEFAULT_RETENTION_POLICY)
    expect(policy.sessionEventMaxSessions).toBeGreaterThan(0)
    expect(policy.agentLogRetentionDays).toBeGreaterThan(0)
  })

  it('合法配置值生效', () => {
    const policy = resolveRetentionPolicy(
      readerWith({
        [RETENTION_POLICY_CONFIG_KEYS.sessionEventMaxSessions]: '5',
        [RETENTION_POLICY_CONFIG_KEYS.agentLogRetentionDays]: '7'
      })
    )
    expect(policy.sessionEventMaxSessions).toBe(5)
    expect(policy.agentLogRetentionDays).toBe(7)
  })

  it.each(['0', '-3', 'abc', '1.5', ''])('非法配置 %j → 收敛显式默认(fail-closed)', (bad) => {
    const policy = resolveRetentionPolicy(
      readerWith({ [RETENTION_POLICY_CONFIG_KEYS.sessionEventMaxSessions]: bad })
    )
    expect(policy.sessionEventMaxSessions).toBe(DEFAULT_RETENTION_POLICY.sessionEventMaxSessions)
  })
})
