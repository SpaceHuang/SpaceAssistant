import { createSnapshotReadRegisteredTool } from '../tools/snapshotReadRegisteredTool'
import type { ToolExecutionContext, ToolExecutorResult } from '../tools/types'
import { getDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { createWikiLifecycleController } from './wikiLifecycle'
import { resolveSharedWikiRoot } from './wikiInit'
import { readWikiConfig } from './wikiConfigReader'

export interface WikiDiscoveredTool { name: string; description: string; input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean } }
export interface WikiToolDiscoveryResult { matches: WikiDiscoveredTool[]; totalMatches: number; truncated: boolean; usage: string }

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): WikiDiscoveredTool => ({
  name: `memory.wiki_${name}`,
  description,
  input_schema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
})
const string = (description: string) => ({ type: 'string', description })
const integer = (description: string, minimum = 1, maximum?: number) => ({ type: 'integer', description, minimum, ...(maximum ? { maximum } : {}) })

export const WIKI_DOMAIN_TOOL_DEFINITIONS: WikiDiscoveredTool[] = [
  tool('get_schema', '读取当前有效 Wiki SCHEMA、分类和诊断。', { section: string('可选规则分区') }),
  tool('search', '按关键词检索标题、摘要和正文；返回稳定页面引用、命中行、有界片段及全部来源项目溯源。', { query: string('搜索词'), categoryId: string('可选分类 ID'), limit: integer('结果数量', 1, 20), cursor: string('续页游标') }, ['query']),
  tool('open_page', '打开页面并固定一个不可变 revision；不返回正文。', { pageId: string('页面 ID'), revision: integer('可选历史版本', 1) }, ['pageId']),
  tool('read_page', '读取固定 revision 的有界正文片段。', { readHandle: string('open_page 返回的读取句柄'), cursor: string('续读游标'), startLine: integer('首片段起始行'), maxChars: integer('最大 Unicode 字符数', 1, 8000) }, ['readHandle']),
  tool('import_source', '导入由应用绑定的来源引用；不接受文件路径。', { sourceRef: string('应用签发的来源引用') }, ['sourceRef']),
  tool('read_source', '读取固定来源版本的有界正文片段。', { sourceId: string('来源 ID'), sourceRevision: integer('可选来源版本'), cursor: string('续读游标'), maxChars: integer('最大 Unicode 字符数', 1, 8000) }, ['sourceId']),
  tool('save_page', '创建或更新页面；创建时省略 pageId 和 expectedRevision；更新时必须同时提供 pageId 与 expectedRevision。', { pageId: string('更新时必填的页面 ID；创建时省略'), title: string('页面标题'), categoryId: string('当前 SCHEMA 分类 ID'), summary: string('页面摘要'), markdown: string('Markdown 正文'), sourceRefs: { type: 'array', items: { type: 'object', properties: { sourceId: string('来源 ID'), sourceRevision: integer('来源版本') }, required: ['sourceId', 'sourceRevision'], additionalProperties: false } }, schemaVersion: integer('采用的 SCHEMA 版本'), expectedRevision: integer('更新时必填的当前页面版本；必须与 pageId 同时提供'), parentPageId: string('可选父页面 ID') }, ['title', 'categoryId', 'summary', 'markdown', 'schemaVersion']),
  tool('move_page', '移动页面到唯一逻辑父级或根页面；省略或传 null 表示根页面。', { pageId: string('页面 ID'), parentPageId: { anyOf: [string('目标父页面 ID'), { type: 'null' }], description: '目标父页面 ID；省略或传 null 表示移至根页面' }, expectedRevision: integer('当前页面版本') }, ['pageId', 'expectedRevision']),
  tool('list_page_revisions', '列出页面可用的不可变历史版本。', { pageId: string('页面 ID') }, ['pageId']),
  tool('restore_page', '准备恢复提案；确认前会展示最终完整页面及全部冲突。', { pageId: string('页面 ID'), targetRevision: integer('目标历史版本'), expectedCurrentRevision: integer('当前页面版本'), title: string('用户明确选择的标题覆盖'), categoryId: string('用户明确选择的分类覆盖'), parentPageId: { anyOf: [string('用户明确选择的父级覆盖'), { type: 'null' }] } }, ['pageId', 'targetRevision', 'expectedCurrentRevision']),
  tool('apply_restore', '应用用户已查看并确认的完整页面恢复提案。', { proposalId: string('恢复提案 ID'), finalPage: { type: 'object', properties: { title: string('最终标题'), categoryId: string('最终分类 ID'), summary: string('最终摘要'), markdown: string('最终正文'), parentPageId: { anyOf: [string('最终父页面 ID'), { type: 'null' }] }, sourceRefs: { type: 'array', items: { type: 'object', properties: { sourceId: string('来源 ID'), sourceRevision: integer('来源版本') }, required: ['sourceId', 'sourceRevision'], additionalProperties: false } } }, required: ['title', 'categoryId', 'summary', 'markdown', 'parentPageId', 'sourceRefs'], additionalProperties: false } }, ['proposalId', 'finalPage']),
  tool('propose_schema_change', '提交完整 SCHEMA 修改提案；不直接写入 SCHEMA。', { content: string('提议的 SCHEMA 全文'), expectedSchemaVersion: integer('当前 SCHEMA 版本') }, ['content', 'expectedSchemaVersion']),
  tool('update_schema', '展示并提交提案返回的完整 before/after 差异；服务核对差异与 proposalId 绑定的内容后，才允许用户确认应用。', { proposalId: string('SCHEMA 提案 ID'), expectedSchemaVersion: integer('提案基线版本'), proposalDiff: { type: 'object', properties: { before: string('当前 SCHEMA 全文'), after: string('提案 SCHEMA 全文') }, required: ['before', 'after'], additionalProperties: false } }, ['proposalId', 'expectedSchemaVersion', 'proposalDiff']),
]

export const WIKI_DISCOVERY_TOOL_DEFINITION = {
  name: 'memory',
  description: '发现 Wiki 知识操作并返回匹配操作的完整参数 schema；只披露工具，不授予访问权限。',
  input_schema: { type: 'object', properties: { query: string('按操作名称或用途筛选；省略时列出全部 Wiki 操作'), limit: integer('结果数量，默认 8，上限 20', 1, 20), offset: integer('分页偏移量', 0) }, additionalProperties: false },
} as const

/** 首轮广告的 discovery executor；schema 发现本身不改变后续工具授权。 */
export const wikiDiscoveryTool = createSnapshotReadRegisteredTool('memory', async (input, context) => {
  const registry = getDefaultAgentRuntime().builtinRegistry
  const available = WIKI_DOMAIN_TOOL_DEFINITIONS.filter((entry) => registry.get(entry.name)).map((entry) => entry.name)
  return executeWikiDiscovery(input, context, new Set(available))
})

export async function executeWikiDiscovery(input: Record<string, unknown>, context: Pick<ToolExecutionContext, 'wikiConfig' | 'userDataDir' | 'appDatabase'>, availableToolNames: ReadonlySet<string> = new Set(WIKI_DOMAIN_TOOL_DEFINITIONS.map((tool) => tool.name))): Promise<ToolExecutorResult> {
  const wikiConfig = context.wikiConfig ?? (context.appDatabase ? readWikiConfig(context.appDatabase) : undefined)
  if (!wikiConfig) return { success: false, error: 'wiki_config_missing' }
  const root = resolveSharedWikiRoot(context.userDataDir, wikiConfig)
  const lifecycle = await createWikiLifecycleController(root).read()
  if (lifecycle.lifecycle !== 'domain_enabled') {
    return { success: false, error: 'wiki_lifecycle_not_ready' }
  }
  return {
    success: true,
    data: discoverWikiTools({
      ...(typeof input.query === 'string' ? { query: input.query } : {}),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
    }, availableToolNames),
  }
}

export function discoverWikiTools(input: { query?: string; limit?: number; offset?: number }, availableToolNames: ReadonlySet<string> = new Set(WIKI_DOMAIN_TOOL_DEFINITIONS.map((tool) => tool.name))): WikiToolDiscoveryResult {
  const query = (input.query ?? '').normalize('NFKC').trim().toLocaleLowerCase()
  const terms = query ? query.split(/\s+/) : []
  const matches = WIKI_DOMAIN_TOOL_DEFINITIONS.filter(entry => availableToolNames.has(entry.name) && (() => {
    const searchable = `${entry.name} ${entry.description}`.normalize('NFKC').toLocaleLowerCase()
    return terms.every(term => searchable.includes(term))
  })())
  const limit = Math.min(20, Math.max(1, Math.floor(input.limit ?? 8)))
  const offset = Math.max(0, Math.floor(input.offset ?? 0))
  const page = matches.slice(offset, offset + limit).map(entry => ({ ...entry, input_schema: { ...entry.input_schema, properties: { ...entry.input_schema.properties } } }))
  const truncated = offset + page.length < matches.length
  return { matches: page, totalMatches: matches.length, truncated, usage: '工具发现只返回 schema，不修改授权集合；调用仍须通过当前 lane 的策略、确认和执行 final-check。' }
}
