import { describe, expect, it, vi } from 'vitest'
import { computeEffectiveTools } from './effectiveTools'
import { assembleInvocation } from './runtime/invocationAssembler'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'

/**
 * P7（偏差 16）：按子调用裁剪工具集。
 * - profile.tools.trim（allow 闭集 / deny 集合）只落工具集，不落提示词；
 * - 嵌套取交集（只能收窄不能加宽），装配期断言违规拒绝并落审计；
 * - 审批白名单平移为数据化实例（封闭集合断言）；
 * - MCP 工具同受裁剪。
 */

vi.mock('electron', () => ({ app: { getLocale: vi.fn(() => 'zh-CN') } }))
vi.mock('./agentLogger/agentLogger', () => ({ logAgentEvent: vi.fn(), logAgentError: vi.fn() }))

const snapshotWith = (names: string[]) => ({
  entries: new Map(names.map((n) => [n, {
    serverId: 'srv1',
    serverName: 'Srv',
    originalName: n,
    mappedName: `mcp__srv1__${n}`,
    description: '',
    inputSchema: {}
  }])),
  budgetDropped: []
})

describe('computeEffectiveTools 按调用裁剪（trim）', () => {
  it('allow 闭集：builtin 与 MCP 名字统一收窄，列表外无效（authorizedToolNames 同步）', () => {
    const r = computeEffectiveTools({
      builtinConfig: DEFAULT_TOOLS_CONFIG,
      mcpSnapshot: snapshotWith(['list_issues', 'create_issue']) as never,
      trim: { allow: ['read_file', 'mcp__srv1__list_issues'] }
    })
    const names = r.tools.map((t) => (t as { name: string }).name)
    expect(names).toContain('read_file')
    // tools 数组为 API compat 名口径；authorizedToolNames 为内部名口径
    expect(names).toContain('mcp_srv1_list_issues')
    expect(names).not.toContain('mcp_srv1_create_issue')
    expect(names).not.toContain('write_file')
    expect(r.authorizedToolNames.has('write_file')).toBe(false)
    expect(r.authorizedToolNames.has('mcp__srv1__create_issue')).toBe(false)
  })

  it('deny 集合：只收窄指定工具', () => {
    const r = computeEffectiveTools({
      builtinConfig: DEFAULT_TOOLS_CONFIG,
      trim: { deny: ['write_file', 'run_shell'] }
    })
    expect(r.authorizedToolNames.has('write_file')).toBe(false)
    expect(r.authorizedToolNames.has('run_shell')).toBe(false)
    expect(r.authorizedToolNames.has('read_file')).toBe(true)
  })

  it('裁剪不落提示词：trim 不改变 system 组装输入（computeEffectiveTools 无 system 产出）', () => {
    const r = computeEffectiveTools({ builtinConfig: DEFAULT_TOOLS_CONFIG, trim: { deny: ['write_file'] } })
    expect(Object.keys(r)).not.toContain('system')
  })
})

describe('装配器嵌套裁剪断言（只能收窄不能加宽）', () => {
  const base = (overrides: Record<string, unknown> = {}) => ({
    requestId: 'r-trim', sessionId: 's-trim', model: 'm',
    messages: [{ role: 'user', content: 'x' }] as never,
    toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp',
    getApiKey: async () => 'k',
    emitFactEvent: () => undefined, emitSessionEvent: async () => undefined,
    ...overrides
  })

  it('子 allow ⊆ 父 allow → 通过（交集语义）', () => {
    const { invocation } = assembleInvocation(base({
      toolsTrim: { allow: ['read_file', 'grep'] },
      parentToolsTrim: { allow: ['read_file', 'grep', 'list_directory'] }
    }) as never)
    expect(invocation.profile.tools.trim?.allow).toEqual(['read_file', 'grep'])
  })

  it('子 allow 超出父 allow → 装配期拒绝（抛错 + 审计日志）', async () => {
    const { logAgentEvent } = await import('./agentLogger/agentLogger')
    vi.mocked(logAgentEvent).mockClear()
    expect(() => assembleInvocation(base({
      toolsTrim: { allow: ['read_file', 'write_file'] },
      parentToolsTrim: { allow: ['read_file'] }
    }) as never)).toThrow('TOOLS_TRIM_WIDEN_DENIED')
    expect(vi.mocked(logAgentEvent)).toHaveBeenCalledWith(
      'info',
      'agent.tools.trim_widen_denied',
      expect.objectContaining({ requestId: 'r-trim' })
    )
  })

  it('父 deny 被子继承（deny 只增不减）', () => {
    const { invocation } = assembleInvocation(base({
      toolsTrim: { deny: ['run_shell'] },
      parentToolsTrim: { deny: ['write_file'] }
    }) as never)
    const deny = invocation.profile.tools.trim?.deny ?? []
    expect(deny).toContain('write_file')
    expect(deny).toContain('run_shell')
  })
})

describe('审批白名单数据化平移（首个实例）', () => {
  it('APPROVAL_READONLY_TOOLS 定义已迁移出 approvalAgent.ts（re-export 兼容）', async () => {
    const { APPROVAL_READONLY_TOOLS } = await import('./confirmation/approvalAgent')
    const toolset = await import('./confirmation/approvalToolset')
    expect(APPROVAL_READONLY_TOOLS).toEqual(toolset.APPROVAL_READONLY_TOOLS)
    // 封闭集合：白名单内容不变
    expect(toolset.APPROVAL_READONLY_TOOLS).toEqual(['read_file', 'list_directory', 'grep', 'list_work_dirs', 'history.read', 'skills.read'])
  })
})
