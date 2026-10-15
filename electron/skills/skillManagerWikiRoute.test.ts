import { describe, expect, it, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAnthropicClient } from '../anthropicClientFactory'
import { DEFAULT_SKILLS_CONFIG, DEFAULT_WIKI_CONFIG } from '../../src/shared/domainTypes'
import type { SkillsConfig, WikiConfig } from '../../src/shared/domainTypes'
import { createSkillManager } from './skillManager'
import { ensureSkillsDirs, getUserSkillsDir } from './skillPaths'
import { invalidateSkillsCache } from './skillCache'

/**
 * W1-a 确定性激活（评审 B2：默认 llm 路由不做 keywordMatch，triggers 不进 catalog，
 * 激活不能依赖路由 LLM 概率）——「提及即激活」必须由硬规则在真实 route 路径保证。
 */
vi.mock('../anthropicClientFactory', () => ({
  createAnthropicClient: vi.fn()
}))

const createClientMock = vi.mocked(createAnthropicClient)

function makeTempDirs(): { userDataPath: string; workDir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-route-'))
  const userDataPath = path.join(root, 'userData')
  const workDir = path.join(root, 'work')
  fs.mkdirSync(userDataPath, { recursive: true })
  fs.mkdirSync(workDir, { recursive: true })
  return { userDataPath, workDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

function createUserSkill(userDataPath: string, name: string, description: string): void {
  const dir = path.join(getUserSkillsDir(userDataPath), name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---
name: ${name}
description: "${description}"
triggers: []
version: "1.0.0"
author: "test"
---

# ${name}
`)
}

function buildManager(dirs: { userDataPath: string; workDir: string }, wikiConfig: WikiConfig) {
  const config: SkillsConfig = { ...DEFAULT_SKILLS_CONFIG }
  return createSkillManager({
    getUserDataPath: () => dirs.userDataPath,
    getWorkDir: () => dirs.workDir,
    getSkillsConfig: () => config,
    getWikiConfig: () => wikiConfig
  })
}

const emptyState = { manualActivated: [], manualDisabled: [] }

describe('skillManager.route wiki-trigger 确定性激活（W1-a）', () => {
  beforeEach(() => {
    invalidateSkillsCache()
    createClientMock.mockReset()
  })

  it('llm 模式路由 LLM 返回空时，含触发词输入仍激活 llm-wiki 且 source=wiki-trigger', async () => {
    const dirs = makeTempDirs()
    try {
      const manager = buildManager(dirs, { ...DEFAULT_WIKI_CONFIG, enabled: true })
      createClientMock.mockReturnValue({
        messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: '{"skills":[]}' }] })) }
      } as never)

      const result = await manager.route({
        userInput: '把这段存入知识库',
        sessionState: emptyState,
        model: 'test-model',
        getApiKey: async () => 'test-key'
      })

      expect(result.skills.map((s) => s.meta.name)).toContain('llm-wiki')
      expect(result.meta.sources['llm-wiki']).toBe('wiki-trigger')
    } finally {
      dirs.cleanup()
    }
  })

  it('路由 LLM 正常返回但不含 llm-wiki 时，硬规则仍必达', async () => {
    const dirs = makeTempDirs()
    try {
      createUserSkill(dirs.userDataPath, 'note-tool', '笔记工具')
      const manager = buildManager(dirs, { ...DEFAULT_WIKI_CONFIG, enabled: true })
      createClientMock.mockReturnValue({
        messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: '{"skills":["note-tool"]}' }] })) }
      } as never)

      const result = await manager.route({
        userInput: '把这段存入知识库',
        sessionState: emptyState,
        model: 'test-model',
        getApiKey: async () => 'test-key'
      })

      expect(result.skills.map((s) => s.meta.name)).toEqual(expect.arrayContaining(['llm-wiki', 'note-tool']))
      expect(result.meta.sources['llm-wiki']).toBe('wiki-trigger')
      expect(result.meta.sources['note-tool']).toBe('llm')
    } finally {
      dirs.cleanup()
    }
  })

  it('路由 LLM 失败（超时）时硬规则兜底，llm-wiki 仍激活', async () => {
    const dirs = makeTempDirs()
    try {
      const manager = buildManager(dirs, { ...DEFAULT_WIKI_CONFIG, enabled: true })
      const timeoutError = new Error('Request timed out')
      timeoutError.name = 'AbortError'
      createClientMock.mockReturnValue({
        messages: { create: vi.fn(async () => { throw timeoutError }) }
      } as never)

      const result = await manager.route({
        userInput: '查一下知识库里有没有相关记录',
        sessionState: emptyState,
        model: 'test-model',
        getApiKey: async () => 'test-key'
      })

      expect(result.skills.map((s) => s.meta.name)).toContain('llm-wiki')
      expect(result.meta.sources['llm-wiki']).toBe('wiki-trigger')
      expect(result.meta.routingFailed).toBe(true)
    } finally {
      dirs.cleanup()
    }
  })

  it('!wikiConfig.enabled 时即便输入含触发词也不激活 llm-wiki', async () => {
    const dirs = makeTempDirs()
    try {
      const manager = buildManager(dirs, { ...DEFAULT_WIKI_CONFIG, enabled: false })
      createClientMock.mockReturnValue({
        messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: '{"skills":[]}' }] })) }
      } as never)

      const result = await manager.route({
        userInput: '把这段存入知识库',
        sessionState: emptyState,
        model: 'test-model',
        getApiKey: async () => 'test-key'
      })

      expect(result.skills.map((s) => s.meta.name)).not.toContain('llm-wiki')
    } finally {
      dirs.cleanup()
    }
  })

  it('enabled 但输入不含任何触发词时不做确定性激活（交给路由 LLM）', async () => {
    const dirs = makeTempDirs()
    try {
      const manager = buildManager(dirs, { ...DEFAULT_WIKI_CONFIG, enabled: true })
      createClientMock.mockReturnValue({
        messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: '{"skills":[]}' }] })) }
      } as never)

      const result = await manager.route({
        userInput: '帮我写一个排序算法',
        sessionState: emptyState,
        model: 'test-model',
        getApiKey: async () => 'test-key'
      })

      expect(result.skills.map((s) => s.meta.name)).not.toContain('llm-wiki')
      expect(result.meta.sources['llm-wiki']).toBeUndefined()
    } finally {
      dirs.cleanup()
    }
  })
})

describe('skillManager.match wiki 过滤（既有契约）', () => {
  it('!enabled 时 match 结果剔除 llm-wiki', () => {
    const dirs = makeTempDirs()
    try {
      ensureSkillsDirs(dirs.userDataPath, dirs.workDir)
      const manager = buildManager(dirs, { ...DEFAULT_WIKI_CONFIG, enabled: false })
      const matched = manager.match('把这段存入知识库', emptyState)
      expect(matched.map((s) => s.meta.name)).not.toContain('llm-wiki')
    } finally {
      dirs.cleanup()
    }
  })

  it('enabled 时 match 命中触发词（keyword 激活保留）', () => {
    const dirs = makeTempDirs()
    try {
      ensureSkillsDirs(dirs.userDataPath, dirs.workDir)
      const manager = buildManager(dirs, { ...DEFAULT_WIKI_CONFIG, enabled: true })
      const matched = manager.match('把这段存入知识库', emptyState)
      expect(matched.map((s) => s.meta.name)).toContain('llm-wiki')
    } finally {
      dirs.cleanup()
    }
  })
})
