import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOLS_CONFIG, mergeToolsConfig } from './domainTypes'

describe('ToolsConfig.grepSearchGitignored（阶段 G，D1：搜索被 Git 忽略的路径）', () => {
  it('默认值为 false（与改动前行为逐字一致，AC-33）', () => {
    expect(DEFAULT_TOOLS_CONFIG.grepSearchGitignored).toBe(false)
  })

  it('缺该字段的旧配置经 mergeToolsConfig 后补 false（无需数据迁移）', () => {
    const legacy = { enabled: true, deniedTools: [], pythonPath: 'python', scriptTimeout: 300, fileCheckpointingEnabled: true, maxFileSnapshots: 100, grepTimeoutSec: 60 }
    const merged = mergeToolsConfig(legacy as never)
    expect(merged.grepSearchGitignored).toBe(false)
  })

  it('显式 true 被保留（G2）', () => {
    expect(mergeToolsConfig({ grepSearchGitignored: true }).grepSearchGitignored).toBe(true)
    expect(mergeToolsConfig({ grepSearchGitignored: false }).grepSearchGitignored).toBe(false)
  })

  it('null/undefined 配置回落默认', () => {
    expect(mergeToolsConfig(null).grepSearchGitignored).toBe(false)
    expect(mergeToolsConfig(undefined).grepSearchGitignored).toBe(false)
  })
})
