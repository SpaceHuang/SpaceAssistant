import { describe, expect, it } from 'vitest'
import { DEFAULT_BROWSER_CONFIG, DEFAULT_SHELL_CONFIG, DEFAULT_WIKI_CONFIG } from '../../../shared/domainTypes'
import { DEFAULT_FEISHU_CONFIG } from '../../../shared/feishuTypes'
import {
  buildConfigModalSnapshot,
  configModalSnapshotsEqual,
  normalizeSettingsTabKey
} from './configModalSnapshot'
import { initLlmServiceTabState } from './llmServiceDrafts'

describe('normalizeSettingsTabKey', () => {
  it('maps legacy tab keys to current IA', () => {
    expect(normalizeSettingsTabKey('llm-service')).toBe('models')
    expect(normalizeSettingsTabKey('llm-defaults')).toBe('models')
    expect(normalizeSettingsTabKey('browser')).toBe('tools')
    expect(normalizeSettingsTabKey('general')).toBe('general')
  })
})

describe('buildConfigModalSnapshot', () => {
  it('treats identical payloads as equal', () => {
    const llmState = initLlmServiceTabState(
      [{ id: 's1', name: 'Main', baseUrl: '', apiKeyPresent: true }],
      's1'
    )
    const base = {
      workDir: '/tmp/work',
      locale: 'zh-CN' as const,
      thinkingEnabled: true,
      models: [{ id: '1', name: 'claude', maximumContext: 200000, maxTokens: 64000, isDefault: true, isFast: false, enabled: true }],
      llmState,
      toolUi: {
        confirmMode: 'diff' as const,
        deniedTools: ['browser'],
        pythonPath: 'python',
        scriptTimeout: 300,
        fileCheckpointingEnabled: true,
        maxFileSnapshots: 100,
        grepTimeoutSec: 60
      },
      maxParallelChatSessions: 3,
      wiki: { ...DEFAULT_WIKI_CONFIG },
      feishu: { ...DEFAULT_FEISHU_CONFIG },
      browser: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowedDomains: [] },
      shell: { ...DEFAULT_SHELL_CONFIG, enabled: true },
      shellEnabled: true
    }
    const a = buildConfigModalSnapshot(base)
    const b = buildConfigModalSnapshot({ ...base, toolUi: { ...base.toolUi, deniedTools: ['browser'] } })
    expect(configModalSnapshotsEqual(a, b)).toBe(true)
  })

  it('detects workDir changes', () => {
    const llmState = initLlmServiceTabState([], '')
    const mk = (workDir: string) =>
      buildConfigModalSnapshot({
        workDir,
        locale: 'zh-CN',
        thinkingEnabled: false,
        models: [],
        llmState,
        toolUi: {
          confirmMode: 'diff',
          deniedTools: [],
          pythonPath: 'python',
          scriptTimeout: 300,
          fileCheckpointingEnabled: true,
          maxFileSnapshots: 100,
          grepTimeoutSec: 60
        },
        maxParallelChatSessions: 3,
        wiki: { ...DEFAULT_WIKI_CONFIG },
        feishu: { ...DEFAULT_FEISHU_CONFIG },
        browser: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowedDomains: [] },
        shell: { ...DEFAULT_SHELL_CONFIG },
        shellEnabled: true
      })
    expect(configModalSnapshotsEqual(mk('/a'), mk('/b'))).toBe(false)
  })

  it('detects locale changes', () => {
    const llmState = initLlmServiceTabState([], '')
    const mk = (locale: 'zh-CN' | 'en-US') =>
      buildConfigModalSnapshot({
        workDir: '/tmp',
        locale,
        thinkingEnabled: false,
        models: [],
        llmState,
        toolUi: {
          confirmMode: 'diff',
          deniedTools: [],
          pythonPath: 'python',
          scriptTimeout: 300,
          fileCheckpointingEnabled: true,
          maxFileSnapshots: 100,
          grepTimeoutSec: 60
        },
        maxParallelChatSessions: 3,
        wiki: { ...DEFAULT_WIKI_CONFIG },
        feishu: { ...DEFAULT_FEISHU_CONFIG },
        browser: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowedDomains: [] },
        shell: { ...DEFAULT_SHELL_CONFIG },
        shellEnabled: true
      })
    expect(configModalSnapshotsEqual(mk('zh-CN'), mk('en-US'))).toBe(false)
  })

  it('treats identical en-US locale payloads as equal', () => {
    const llmState = initLlmServiceTabState([], '')
    const base = {
      workDir: '/tmp',
      locale: 'en-US' as const,
      thinkingEnabled: false,
      models: [],
      llmState,
      toolUi: {
        confirmMode: 'diff' as const,
        deniedTools: [],
        pythonPath: 'python',
        scriptTimeout: 300,
        fileCheckpointingEnabled: true,
        maxFileSnapshots: 100,
        grepTimeoutSec: 60
      },
      maxParallelChatSessions: 3,
      wiki: { ...DEFAULT_WIKI_CONFIG },
      feishu: { ...DEFAULT_FEISHU_CONFIG },
      browser: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowedDomains: [] },
      shell: { ...DEFAULT_SHELL_CONFIG },
      shellEnabled: true
    }
    const a = buildConfigModalSnapshot(base)
    const b = buildConfigModalSnapshot({ ...base, locale: 'en-US' })
    expect(configModalSnapshotsEqual(a, b)).toBe(true)
    expect(JSON.parse(a).locale).toBe('en-US')
  })
})
