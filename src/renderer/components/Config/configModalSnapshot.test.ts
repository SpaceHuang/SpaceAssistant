import { describe, expect, it } from 'vitest'
import { DEFAULT_BROWSER_CONFIG, DEFAULT_SHELL_CONFIG, DEFAULT_WIKI_CONFIG, DEFAULT_WORKSPACE_LAYOUT_CONFIG } from '../../../shared/domainTypes'
import { DEFAULT_FEISHU_CONFIG } from '../../../shared/feishuTypes'
import {
  buildConfigModalSnapshot,
  configModalSnapshotsEqual,
  normalizeSettingsTabKey
} from './configModalSnapshot'
import { initLlmServiceTabState } from './llmServiceDrafts'

const defaultWorkspaceLayout = {
  ...DEFAULT_WORKSPACE_LAYOUT_CONFIG,
  extensionSubdirMap: [...DEFAULT_WORKSPACE_LAYOUT_CONFIG.extensionSubdirMap]
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
      browser: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowedDomains: [] },
      shell: { ...DEFAULT_SHELL_CONFIG, enabled: true },
      shellEnabled: true,
      workspaceLayout: defaultWorkspaceLayout
    }
    const a = buildConfigModalSnapshot(base)
    const b = buildConfigModalSnapshot({ ...base, toolUi: { ...base.toolUi, deniedTools: ['browser'] } })
    expect(configModalSnapshotsEqual(a, b)).toBe(true)
  })

  it('detects workDirProfiles changes', () => {
    const llmState = initLlmServiceTabState([], [], [])
    const mk = (pathValue: string) =>
      buildConfigModalSnapshot({
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
        browser: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowedDomains: [] },
        shell: { ...DEFAULT_SHELL_CONFIG },
        shellEnabled: true,
        workspaceLayout: defaultWorkspaceLayout
      })
    expect(configModalSnapshotsEqual(mk('/a'), mk('/b'))).toBe(false)
  })

  it('detects locale changes', () => {
    const llmState = initLlmServiceTabState([], [], [])
    const mk = (locale: 'zh-CN' | 'en-US') =>
      buildConfigModalSnapshot({
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
        browser: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowedDomains: [] },
        shell: { ...DEFAULT_SHELL_CONFIG },
        shellEnabled: true,
        workspaceLayout: defaultWorkspaceLayout
      })
    expect(configModalSnapshotsEqual(mk('zh-CN'), mk('en-US'))).toBe(false)
  })

  it('treats identical en-US locale payloads as equal', () => {
    const llmState = initLlmServiceTabState([], [], [])
    const base = {
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
      browser: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowedDomains: [] },
      shell: { ...DEFAULT_SHELL_CONFIG },
      shellEnabled: true,
      workspaceLayout: defaultWorkspaceLayout
    }
    const a = buildConfigModalSnapshot(base)
    const b = buildConfigModalSnapshot({ ...base, locale: 'en-US' })
    expect(configModalSnapshotsEqual(a, b)).toBe(true)
    expect(JSON.parse(a).locale).toBe('en-US')
  })
})
