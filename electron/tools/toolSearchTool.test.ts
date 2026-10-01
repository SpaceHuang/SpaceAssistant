import { describe, expect, it } from 'vitest'
import { executeToolSearch, TOOL_SEARCH_MAX_BYTES } from './toolSearchTool'
import type { McpToolSnapshotEntry } from '../mcp/mcpToolRegistry'
import type { ToolExecutionContext } from './types'

function entry(overrides: Partial<McpToolSnapshotEntry> & { mappedName: string; originalName?: string; serverName?: string }): McpToolSnapshotEntry {
  return {
    serverId: 'srv1',
    serverName: '服务一',
    originalName: overrides.originalName ?? overrides.mappedName,
    description: overrides.description ?? '',
    inputSchema: overrides.inputSchema ?? { type: 'object', properties: {} },
    serverId: overrides.serverId ?? 'srv1',
    serverName: overrides.serverName ?? '服务一',
    ...overrides
  }
}

function contextWith(entries: McpToolSnapshotEntry[]): ToolExecutionContext {
  return {
    workDir: '/tmp', userDataDir: '/tmp/user', requestId: 'req', toolUseId: 'call1',
    sessionId: 'sess', sendProgress: () => undefined, signal: new AbortController().signal,
    fileStateCache: {} as ToolExecutionContext['fileStateCache'],
    toolsConfig: { enabled: true, allowedTools: [], deniedTools: [], pythonPath: 'python', scriptTimeout: 300, fileCheckpointingEnabled: true, maxFileSnapshots: 100, grepTimeoutSec: 60 },
    mcpToolSnapshot: { entries: new Map(entries.map((e) => [e.mappedName, e])) }
  } as ToolExecutionContext
}

describe('executeToolSearch（FR2 / §6.3）', () => {
  const feishu = entry({ mappedName: 'mcp_feishu_create_doc_0001', originalName: 'create_doc', serverId: 'srvF', serverName: '飞书', description: '创建飞书文档，支持富文本' })
  const github = entry({ mappedName: 'mcp_github_list_issues_0002', originalName: 'list_issues', serverId: 'srvG', serverName: 'github', description: 'List issues of a GitHub repository' })
  const calc = entry({ mappedName: 'mcp_calc_add_0003', originalName: 'add', serverId: 'srvC', serverName: '计算器', description: '两数相加' })
  const all = [feishu, github, calc]

  it('名字与描述大小写不敏感子串匹配', () => {
    const result = executeToolSearch({ query: 'ISSUE' }, contextWith(all))
    expect(result.matches.map((m) => m.name)).toEqual([github.mappedName])
  })

  it('匹配域含 mappedName / originalName / 服务名 / 描述全文', () => {
    // originalName 命中
    expect(executeToolSearch({ query: 'create_doc' }, contextWith(all)).matches.map((m) => m.name)).toEqual([feishu.mappedName])
    // 服务名命中
    expect(executeToolSearch({ query: 'github' }, contextWith(all)).matches.map((m) => m.name)).toEqual([github.mappedName])
    // 描述全文命中（非索引行）
    expect(executeToolSearch({ query: '富文本' }, contextWith(all)).matches.map((m) => m.name)).toEqual([feishu.mappedName])
  })

  it('query 空格分词后任一词命中即候选，多词命中排前（跨语言召回）', () => {
    const a = entry({ mappedName: 'mcp_a_0001', originalName: 'alpha_doc', description: 'doc 工具' })
    const b = entry({ mappedName: 'mcp_b_0002', originalName: 'beta_doc', description: '仅描述含 alpha' })
    const c = entry({ mappedName: 'mcp_c_0003', originalName: 'gamma', description: '无关' })
    const result = executeToolSearch({ query: 'alpha doc' }, contextWith([a, b, c]))
    // a 命中两词（名+描述），b 只命中一个词；c 不命中
    expect(result.matches.map((m) => m.name)).toEqual([a.mappedName, b.mappedName])
    expect(result.totalMatches).toBe(2)
  })

  it('权重排序：名字命中 > 描述命中，同分按快照顺序（稳定）', () => {
    const byDesc = entry({ mappedName: 'mcp_d1_0001', originalName: 'zebra_one', description: '含 keyword 的描述' })
    const byName = entry({ mappedName: 'mcp_n1_0002', originalName: 'keyword_tool', description: '别的' })
    const first = entry({ mappedName: 'mcp_f1_0003', originalName: 'another', description: 'keyword 也在这里' })
    const result = executeToolSearch({ query: 'keyword' }, contextWith([byDesc, byName, first]))
    // byName 名字命中排最前；byDesc 与 first 同为描述命中，按快照顺序
    expect(result.matches.map((m) => m.name)).toEqual([byName.mappedName, byDesc.mappedName, first.mappedName])
  })

  it('server 过滤：按名称或 id（大小写不敏感）', () => {
    const onlyGithub = executeToolSearch({ query: '', server: 'SRVG' }, contextWith(all))
    expect(onlyGithub.matches.map((m) => m.name)).toEqual([github.mappedName])
    const byName = executeToolSearch({ query: '', server: '飞书' }, contextWith(all))
    expect(byName.matches.map((m) => m.name)).toEqual([feishu.mappedName])
  })

  it('空 query = 按快照顺序分页列出全部（遍历保底），offset/limit 分页可穷尽', () => {
    const many = Array.from({ length: 23 }, (_, i) => entry({ mappedName: `mcp_x_${String(i).padStart(4, '0')}` }))
    const page1 = executeToolSearch({ query: '', limit: 10 }, contextWith(many))
    expect(page1.matches).toHaveLength(10)
    expect(page1.totalMatches).toBe(23)
    expect(page1.truncated).toBe(true)
    const page2 = executeToolSearch({ query: '', limit: 10, offset: 10 }, contextWith(many))
    expect(page2.matches).toHaveLength(10)
    const page3 = executeToolSearch({ query: '', limit: 10, offset: 20 }, contextWith(many))
    expect(page3.matches).toHaveLength(3)
    expect(page3.truncated).toBe(false)
    // 三页并集 = 全池
    const seen = new Set([...page1.matches, ...page2.matches, ...page3.matches].map((m) => m.name))
    expect(seen.size).toBe(23)
  })

  it('limit 默认 5、钳制 [1,10]；offset 钳制 ≥0', () => {
    const many = Array.from({ length: 12 }, (_, i) => entry({ mappedName: `mcp_x_${String(i).padStart(4, '0')}` }))
    expect(executeToolSearch({}, contextWith(many)).matches).toHaveLength(5)
    expect(executeToolSearch({ query: '', limit: 99 }, contextWith(many)).matches).toHaveLength(10)
    expect(executeToolSearch({ query: '', limit: 0 }, contextWith(many)).matches).toHaveLength(1)
    expect(executeToolSearch({ query: '', limit: -3 }, contextWith(many)).matches).toHaveLength(1)
    expect(executeToolSearch({ query: '', offset: -5 }, contextWith(many)).matches).toHaveLength(5)
  })

  it('query 超长截断到 256 字符，不作为协议错误', () => {
    const result = executeToolSearch({ query: 'x'.repeat(300) }, contextWith(all))
    expect(result.matches).toEqual([])
    expect(typeof result.usage).toBe('string')
  })

  it('无命中：matches 为空 + 引导文案，不算工具失败', () => {
    const result = executeToolSearch({ query: '不存在的词' }, contextWith(all))
    expect(result.matches).toEqual([])
    expect(result.totalMatches).toBe(0)
    expect(result.usage).toContain('tool_search')
  })

  it('描述按快照原文返回（≤4000 字符），携带完整 input_schema', () => {
    const long = entry({ mappedName: 'mcp_long_0001', description: '详'.repeat(4000) })
    const result = executeToolSearch({ query: '详' }, contextWith([long]))
    expect(result.matches[0]!.description).toHaveLength(4000)
    expect(result.matches[0]!.input_schema).toEqual(long.inputSchema)
    expect(result.matches[0]!.server).toBe('服务一')
  })

  it('返回体总量 ≤32 KiB：溢出时自低排名收缩描述；input_schema 永不截断', () => {
    // 构造多条大描述条目：完整装载必超 32 KiB
    const schema = { type: 'object', properties: { a: { type: 'string' } } }
    const big = Array.from({ length: 12 }, (_, i) =>
      entry({ mappedName: `mcp_big_${String(i).padStart(2, '0')}`, description: '描'.repeat(3800), inputSchema: schema }))
    const result = executeToolSearch({ query: '描', limit: 10 }, contextWith(big))
    const serialized = JSON.stringify(result)
    expect(serialized.length).toBeLessThanOrEqual(TOOL_SEARCH_MAX_BYTES)
    // schema 未被截断
    for (const match of result.matches) {
      expect(match.input_schema).toEqual(schema)
    }
    // 至少装入 1 条且少于全部命中（发生了溢出收缩/停止追加）
    expect(result.matches.length).toBeGreaterThanOrEqual(1)
    expect(result.matches.length).toBeLessThan(10)
    expect(result.truncated).toBe(true)
    // usage 注明描述被精简
    expect(result.usage).toContain('描述')
  })

  it('32 KiB 上限是天花板而非填充物：小结果集不受影响（usage 无精简说明）', () => {
    const result = executeToolSearch({ query: '飞书' }, contextWith(all))
    expect(result.matches).toHaveLength(1)
    expect(result.truncated).toBe(false)
    expect(result.usage).not.toContain('已精简')
  })

  it('快照为空：返回空结果 + 引导文案', () => {
    const result = executeToolSearch({ query: '' }, contextWith([]))
    expect(result.matches).toEqual([])
    expect(result.totalMatches).toBe(0)
  })

  it('usage 固定提示 schema 已下发、可下一轮直接调用', () => {
    const result = executeToolSearch({ query: '飞书' }, contextWith(all))
    expect(result.usage).toContain('下一轮')
  })
})
