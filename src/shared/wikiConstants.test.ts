import { describe, expect, it } from 'vitest'
import { DEFAULT_WIKI_ROOT_DIRNAME, WIKI_VOCABULARY_PREFIX } from './wikiConstants'

// D9（wiki-shared-centralized-storage-requirement §4.1）：词汇前缀与默认物理目录名
// 必须单点定义；此测试防误改（词汇前缀稳定性依赖：历史聊天链接 / 技能 / SCHEMA）。
describe('wikiConstants', () => {
  it('WIKI_VOCABULARY_PREFIX 为 Agent 词汇前缀 llm-wiki（历史链接/技能/SCHEMA 依赖，不可变更）', () => {
    expect(WIKI_VOCABULARY_PREFIX).toBe('llm-wiki')
  })

  it('DEFAULT_WIKI_ROOT_DIRNAME 为默认物理目录名 llm-wiki（磁盘目录名，可经配置改名）', () => {
    expect(DEFAULT_WIKI_ROOT_DIRNAME).toBe('llm-wiki')
  })

  it('两者均为不含路径分隔符的单段目录/前缀名', () => {
    expect(WIKI_VOCABULARY_PREFIX).not.toMatch(/[/\\]/)
    expect(DEFAULT_WIKI_ROOT_DIRNAME).not.toMatch(/[/\\]/)
  })
})
