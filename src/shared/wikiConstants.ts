/**
 * LLM Wiki 共享常量（D9 命名不写死的唯一定义点）。
 *
 * - WIKI_VOCABULARY_PREFIX：Agent / UI / 历史聊天链接使用的 workDir 相对词汇前缀。
 *   保持稳定（历史链接、技能文档、SCHEMA 均依赖），不允许随物理目录改名。
 * - DEFAULT_WIKI_ROOT_DIRNAME：共享库在 userData 下的默认物理目录名，
 *   实际目录名一律读 `wiki.rootPath` 配置（改名 = 受控 rename），此值仅作默认与迁移基准。
 *
 * 值变更约束见 src/shared/wikiConstants.test.ts 与
 * docs/requirement/wiki-shared-centralized-storage-requirement.md §4.1-D9。
 */
export const WIKI_VOCABULARY_PREFIX = 'llm-wiki'

export const DEFAULT_WIKI_ROOT_DIRNAME = 'llm-wiki'
