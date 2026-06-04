import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BROWSER_CONFIG,
  DEFAULT_FEISHU_CONFIG,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_TOOLS_CONFIG,
  DEFAULT_WIKI_CONFIG,
  mergeFeishuConfig,
  stripPlanFieldsFromAppConfig
} from './domainTypes'
import {
  SESSION_META_PLAN,
  SESSION_META_PLAN_DRAFTING,
  SESSION_META_PLAN_EXECUTION,
  SESSION_META_PENDING_PLAN,
  SESSION_PLAN_METADATA_KEYS,
  hasPlanMetadataKeys,
  stripPlanFieldsFromSessionMetadata
} from './planTypes'

describe('stripPlanFieldsFromSessionMetadata', () => {
  it('removes all plan metadata keys', () => {
    const metadata: Record<string, unknown> = {
      title: 'keep',
      [SESSION_META_PLAN]: { planId: 'p1' },
      [SESSION_META_PENDING_PLAN]: { planId: 'p2' },
      [SESSION_META_PLAN_DRAFTING]: true,
      [SESSION_META_PLAN_EXECUTION]: { runState: 'running' }
    }
    const stripped = stripPlanFieldsFromSessionMetadata(metadata)
    expect(stripped).toEqual({ title: 'keep' })
    for (const key of SESSION_PLAN_METADATA_KEYS) {
      expect(stripped).not.toHaveProperty(key)
    }
  })

  it('is idempotent', () => {
    const metadata = { [SESSION_META_PLAN]: { planId: 'p1' }, foo: 'bar' }
    const once = stripPlanFieldsFromSessionMetadata(metadata)
    const twice = stripPlanFieldsFromSessionMetadata(once)
    expect(twice).toEqual(once)
  })

  it('no-ops when no plan keys', () => {
    const metadata = { title: 'x' }
    expect(stripPlanFieldsFromSessionMetadata(metadata)).toEqual({ title: 'x' })
    expect(hasPlanMetadataKeys(metadata)).toBe(false)
  })
})

describe('stripPlanFieldsFromAppConfig', () => {
  const baseConfig = {
    locale: 'zh-CN' as const,
    apiKeyPresent: true,
    baseUrl: 'https://api.example.com',
    llmServices: [],
    activeLlmServiceId: '',
    model: 'm',
    defaultModel: 'm',
    models: [],
    thinkingEnabled: true,
    workDir: '/tmp',
    workDirProfiles: [],
    activeWorkDirProfileId: 'default',
    maxParallelChatSessions: 2,
    tools: { ...DEFAULT_TOOLS_CONFIG },
    skills: { ...DEFAULT_SKILLS_CONFIG },
    wiki: { ...DEFAULT_WIKI_CONFIG },
    feishu: mergeFeishuConfig({
      remotePlanMode: 'always',
      remotePlanKeywords: ['重构']
    } as Record<string, unknown>),
    browser: { ...DEFAULT_BROWSER_CONFIG }
  }

  it('removes legacy defaultChatMode, plan, and feishu plan fields', () => {
    const legacy = {
      ...baseConfig,
      defaultChatMode: 'plan',
      plan: { executionMode: 'auto' }
    }
    const stripped = stripPlanFieldsFromAppConfig(legacy)
    expect(stripped).not.toHaveProperty('defaultChatMode')
    expect(stripped).not.toHaveProperty('plan')
    expect(stripped.feishu).not.toHaveProperty('remotePlanMode')
    expect(stripped.feishu).not.toHaveProperty('remotePlanKeywords')
    expect(stripped.feishu.enabled).toBe(DEFAULT_FEISHU_CONFIG.enabled)
  })

  it('is idempotent for feishu block', () => {
    const once = stripPlanFieldsFromAppConfig({
      ...baseConfig,
      defaultChatMode: 'plan'
    })
    const twice = stripPlanFieldsFromAppConfig(once)
    expect(twice.feishu).toEqual(once.feishu)
  })
})
