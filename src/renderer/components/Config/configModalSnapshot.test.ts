import { describe, expect, it } from 'vitest'
import { DEFAULT_BROWSER_CONFIG, DEFAULT_SHELL_CONFIG, DEFAULT_WIKI_CONFIG } from '../../../shared/domainTypes'
import type { AppConfig } from '../../../shared/domainTypes'
import { DEFAULT_FEISHU_CONFIG } from '../../../shared/feishuTypes'
import { DEFAULT_WECHAT_CONFIG } from '../../../shared/wechatTypes'
import {
  buildConfigModalSnapshot,
  buildConfigModalSnapshotFromConfig,
  configModalSnapshotsEqual,
  normalizeSettingsTabKey
} from './configModalSnapshot'
import { initLlmServiceTabState } from './llmServiceDrafts'


const preferredIds = {
  preferredLanguageModelId: 'lang-1',
  preferredFastLanguageModelId: 'fast-1',
  preferredVisionModelId: 'vision-1'
}


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
      [{ id: 's1', name: 'Main', baseUrl: '', apiKeyPresent: true, supportedModelIds: ['1'] }],
      ['s1'],
      ['1']
    )
    const base = {
      ...preferredIds,
      workDirProfiles: [{ id: 'd1', name: 'Work', path: '/tmp/work', isDefault: true }],
      locale: 'zh-CN' as const,
      thinkingEnabled: true,
      models: [{ id: '1', name: 'claude', maximumContext: 200000, maxTokens: 64000, isDefault: true, isFast: false, isVision: false, enabled: true }],
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
      wechat: { ...DEFAULT_WECHAT_CONFIG },
      browser: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowedDomains: [] },
      shell: { ...DEFAULT_SHELL_CONFIG, enabled: true },
      shellEnabled: true,
    }
    const a = buildConfigModalSnapshot(base)
    const b = buildConfigModalSnapshot({ ...base, toolUi: { ...base.toolUi, deniedTools: ['browser'] } })
    expect(configModalSnapshotsEqual(a, b)).toBe(true)
  })

  it('detects workDirProfiles changes', () => {
    const llmState = initLlmServiceTabState([], [], [])
    const mk = (pathValue: string) =>
      buildConfigModalSnapshot({
        ...preferredIds,
        workDirProfiles: [{ id: 'd1', name: 'Work', path: pathValue, isDefault: true }],
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
        wechat: { ...DEFAULT_WECHAT_CONFIG },
        browser: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowedDomains: [] },
        shell: { ...DEFAULT_SHELL_CONFIG },
        shellEnabled: true,
      })
    expect(configModalSnapshotsEqual(mk('/a'), mk('/b'))).toBe(false)
  })

  it('detects locale changes', () => {
    const llmState = initLlmServiceTabState([], [], [])
    const mk = (locale: 'zh-CN' | 'en-US') =>
      buildConfigModalSnapshot({
        ...preferredIds,
        workDirProfiles: [{ id: 'd1', name: 'Work', path: '/tmp', isDefault: true }],
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
        wechat: { ...DEFAULT_WECHAT_CONFIG },
        browser: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowedDomains: [] },
        shell: { ...DEFAULT_SHELL_CONFIG },
        shellEnabled: true,
      })
    expect(configModalSnapshotsEqual(mk('zh-CN'), mk('en-US'))).toBe(false)
  })

  it('treats identical en-US locale payloads as equal', () => {
    const llmState = initLlmServiceTabState([], [], [])
    const base = {
      ...preferredIds,
      workDirProfiles: [{ id: 'd1', name: 'Work', path: '/tmp', isDefault: true }],
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
      wechat: { ...DEFAULT_WECHAT_CONFIG },
      browser: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowedDomains: [] },
      shell: { ...DEFAULT_SHELL_CONFIG },
      shellEnabled: true,
    }
    const a = buildConfigModalSnapshot(base)
    const b = buildConfigModalSnapshot({ ...base, locale: 'en-US' })
    expect(configModalSnapshotsEqual(a, b)).toBe(true)
    expect(JSON.parse(a).locale).toBe('en-US')
  })

  it('detects wechat config changes', () => {
    const llmState = initLlmServiceTabState([], [], [])
    const mk = (enabled: boolean) =>
      buildConfigModalSnapshot({
        ...preferredIds,
        workDirProfiles: [{ id: 'd1', name: 'Work', path: '/tmp', isDefault: true }],
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
        wechat: { ...DEFAULT_WECHAT_CONFIG, enabled },
        browser: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowedDomains: [] },
        shell: { ...DEFAULT_SHELL_CONFIG },
        shellEnabled: true,
      })
    expect(configModalSnapshotsEqual(mk(false), mk(true))).toBe(false)
  })
})

describe('buildConfigModalSnapshot 优选默认模型', () => {
  const base = {
    ...preferredIds,
    workDirProfiles: [],
    locale: 'zh-CN' as const,
    thinkingEnabled: false,
    models: [],
    llmState: initLlmServiceTabState([], [], []),
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
    wechat: { ...DEFAULT_WECHAT_CONFIG },
    browser: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowedDomains: [] },
    shell: { ...DEFAULT_SHELL_CONFIG },
    shellEnabled: true
  }

  it('优选默认语言大模型变化时快照必须变化（否则只能改选、无法保存生效）', () => {
    const a = buildConfigModalSnapshot(base)
    const b = buildConfigModalSnapshot({ ...base, preferredLanguageModelId: 'fast-model-id' })
    expect(configModalSnapshotsEqual(a, b)).toBe(false)
  })

  it('优选快速 / 视觉大模型变化时快照必须变化', () => {
    expect(
      configModalSnapshotsEqual(
        buildConfigModalSnapshot(base),
        buildConfigModalSnapshot({ ...base, preferredFastLanguageModelId: 'other-fast' })
      )
    ).toBe(false)
    expect(
      configModalSnapshotsEqual(
        buildConfigModalSnapshot(base),
        buildConfigModalSnapshot({ ...base, preferredVisionModelId: 'other-vision' })
      )
    ).toBe(false)
  })

  it('基线快照覆盖优选默认模型（保存后不残留未保存改动）', () => {
    const mk = (preferredLanguageModelId: string) =>
      buildConfigModalSnapshotFromConfig(
        {
          ...preferredIds,
          preferredLanguageModelId,
          workDirProfiles: [],
          locale: 'zh-CN',
          thinkingEnabled: false,
          models: [],
          tools: {
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
          wechat: { ...DEFAULT_WECHAT_CONFIG },
          browser: { ...DEFAULT_BROWSER_CONFIG },
          shell: { ...DEFAULT_SHELL_CONFIG }
        } as unknown as AppConfig,
        initLlmServiceTabState([], [], []),
        [],
        true
      )
    expect(configModalSnapshotsEqual(mk('a'), mk('b'))).toBe(false)
  })
})
