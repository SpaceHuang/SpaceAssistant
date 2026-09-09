import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from './database/testHelpers'
import { createSession, setConfigValue } from './database'
import { resolveTrustedTurnExecutionConfig } from './turnExecutionConfig'

describe('resolveTrustedTurnExecutionConfig', () => {
  it.each(['desktop', 'feishu', 'wechat'] as const)('%s 从同一可信 session 配置生成规范化快照', async (lane) => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: lane, model: 'deepseek-chat', maxTokens: 8192 })
    setConfigValue(db, 'config.thinkingEnabled', 'false')
    setConfigValue(db, 'config.locale', 'zh-CN')

    await expect(resolveTrustedTurnExecutionConfig(db, session.id, lane)).resolves.toMatchObject({
      lane, model: 'deepseek-chat', maxTokens: 8192, enableThinking: false, locale: 'zh-CN'
    })
  })

  it('拒绝不存在的 session，不接受调用方伪造网络配置', async () => {
    const db = createMemoryAppDb()
    await expect(resolveTrustedTurnExecutionConfig(db, 'missing', 'desktop')).rejects.toThrow('TURN_SESSION_NOT_FOUND')
  })

  it('带图 turn 在 prepare 阶段从主进程配置冻结视觉模型绑定', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'vision', model: 'deepseek-chat', maxTokens: 8192 })
    setConfigValue(db, 'config.models', JSON.stringify([
      { id: 'text', name: 'deepseek-chat', maximumContext: 128000, maxTokens: 8192, isDefault: false, isFast: false, isVision: false, enabled: true },
      { id: 'vision', name: 'deepseek-vl', maximumContext: 128000, maxTokens: 8192, isDefault: false, isFast: false, isVision: true, enabled: true }
    ]))
    setConfigValue(db, 'config.llmServices', JSON.stringify([
      { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.example/v1', supportedModelIds: ['text', 'vision'] }
    ]))
    setConfigValue(db, 'config.activeLlmServiceIds', JSON.stringify(['deepseek']))
    setConfigValue(db, 'config.preferredVisionModelId', 'vision')

    await expect(resolveTrustedTurnExecutionConfig(
      db,
      session.id,
      'desktop',
      { projectMemoryEnabled: true },
      { requiresVision: true }
    )).resolves.toMatchObject({
      model: 'deepseek-vl',
      llmServiceId: 'deepseek',
      effectiveModelForUsage: 'deepseek-vl'
    })
  })
})
