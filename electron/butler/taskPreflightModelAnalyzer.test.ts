import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTaskPreflightModelAnalyzer } from './taskPreflightModelAnalyzer'
import { resolveLlmCredentialsForPair } from '../llmServiceResolver'
import { createAnthropicClient } from '../anthropicClientFactory'

vi.mock('../llmServiceResolver', () => ({ resolveLlmCredentialsForPair: vi.fn() }))
vi.mock('../anthropicClientFactory', () => ({ createAnthropicClient: vi.fn() }))

describe('createTaskPreflightModelAnalyzer', () => {
  const create = vi.fn()
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveLlmCredentialsForPair).mockResolvedValue({
      model: { id: 'model-id', name: 'provider-model', enabled: true } as never,
      serviceId: 'service-id', providerModelName: 'provider-model', baseUrl: 'https://model.test', getApiKey: async () => 'api-key'
    })
    vi.mocked(createAnthropicClient).mockReturnValue({ messages: { create } } as never)
  })

  it('calls only the task selected model with structured analysis input and no tools', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '{"targets":[],"requiredPermissions":[],"clarifications":[],"suggestedDirectories":[]}' }] })
    const analyzer = createTaskPreflightModelAnalyzer({} as never, { modelId: 'model-id', modelServiceId: 'service-id' })
    const controller = new AbortController()
    await expect(analyzer.analyze({ prompt: 'report', scheduleSummary: 'daily', deliverySummary: 'desktop', authorizedRoots: ['/workspace'], outputRoot: '/results', facts: {} as never, tools: [], responseFormat: 'json' }, controller.signal)).resolves.toEqual({ targets: [], requiredPermissions: [], clarifications: [], suggestedDirectories: [] })
    expect(resolveLlmCredentialsForPair).toHaveBeenCalledWith({}, 'model-id', 'service-id')
    expect(createAnthropicClient).toHaveBeenCalledWith('api-key', 'https://model.test')
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'provider-model', messages: [{ role: 'user', content: expect.stringContaining('"task":"report"') }], system: expect.stringContaining('不执行、不授权') }), { signal: controller.signal })
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('tools')
  })

  it('accepts a fenced JSON response from an Anthropic-compatible model', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '```json\n{"targets":[{"kind":"exact","path":"/workspace","targetType":"directory"}],"requiredPermissions":[{"tool":"run_shell","command":"git log --oneline -5","workingDirectory":"/workspace","timeout":60}],"clarifications":[],"suggestedDirectories":[]}\n```' }] })
    const analyzer = createTaskPreflightModelAnalyzer({} as never, { modelId: 'model-id', modelServiceId: 'service-id' })

    await expect(analyzer.analyze({ prompt: 'inspect Git history', scheduleSummary: 'daily', deliverySummary: 'desktop', authorizedRoots: ['/workspace'], facts: {} as never, tools: [], responseFormat: 'json' }, new AbortController().signal))
      .resolves.toEqual({ targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }], requiredPermissions: [{ tool: 'run_shell', command: 'git log --oneline -5', workingDirectory: '/workspace', timeout: 60 }], clarifications: [], suggestedDirectories: [] })
    expect(create.mock.calls[0]?.[0]).toMatchObject({ max_tokens: 2048 })
  })

  it('identifies a response truncated by the provider token limit', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '{"targets":[' }], stop_reason: 'max_tokens' })
    const analyzer = createTaskPreflightModelAnalyzer({} as never, { modelId: 'model-id', modelServiceId: 'service-id' })

    await expect(analyzer.analyze({} as never, new AbortController().signal)).rejects.toThrow('PREFLIGHT_MODEL_TRUNCATED_RESPONSE')
  })

  it('rejects model output that omits a required delivery field', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '{"targets":[],"requiredPermissions":[],"clarifications":[]}' }] })
    const analyzer = createTaskPreflightModelAnalyzer({} as never, { modelId: 'model-id', modelServiceId: 'service-id' })

    await expect(analyzer.analyze({} as never, new AbortController().signal)).rejects.toThrow('PREFLIGHT_MODEL_INVALID_SCHEMA')
  })

  it('asks the model to identify exact unclear prompt fragments and structured reasons', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '{"targets":[],"requiredPermissions":[],"clarifications":[{"reference":"帮我处理一下","reasonCode":"scope_unclear"}],"suggestedDirectories":[]}' }] })
    const analyzer = createTaskPreflightModelAnalyzer({} as never, { modelId: 'model-id', modelServiceId: 'service-id' })
    const output = await analyzer.analyze({ prompt: '帮我处理一下', scheduleSummary: 'daily', deliverySummary: 'desktop', authorizedRoots: ['/workspace'], outputRoot: '/results', facts: { gitRepositories: ['/workspace'] } as never, tools: [], responseFormat: 'json' }, new AbortController().signal)

    expect(output).toMatchObject({ clarifications: [{ reference: '帮我处理一下', reasonCode: 'scope_unclear' }] })
    expect(create.mock.calls[0]?.[0].system).toContain('clarifications')
    expect(create.mock.calls[0]?.[0].messages).toMatchObject([{ content: expect.stringContaining('"outputRoot":"/results"') }])
    expect(create.mock.calls[0]?.[0].messages).toMatchObject([{ content: expect.stringContaining('"authorizedRoots":["/workspace"]') }])
  })

  it('asks the analyzer to propose Shell access for Git history without implying prior user approval', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '{"targets":[{"kind":"exact","path":"/workspace","targetType":"directory"}],"requiredPermissions":[{"tool":"run_shell","command":"git log --oneline -5","workingDirectory":"/workspace"}],"clarifications":[],"suggestedDirectories":[]}' }] })
    const analyzer = createTaskPreflightModelAnalyzer({} as never, { modelId: 'model-id', modelServiceId: 'service-id' })
    const output = await analyzer.analyze({
      prompt: '总结昨天合并到 main 的提交', scheduleSummary: 'daily', deliverySummary: 'desktop',
      authorizedRoots: ['/workspace'], outputRoot: '/results',
      facts: { gitRepositories: ['/workspace'] } as never, tools: [], responseFormat: 'json'
    }, new AbortController().signal)

    expect(create.mock.calls[0]?.[0].system).toContain('只分析、不执行、不授权')
    expect(create.mock.calls[0]?.[0].system).toContain('timeout')
    expect(create.mock.calls[0]?.[0].system).toContain('本机事实源')
    expect(create.mock.calls[0]?.[0].system).toContain('run_shell')
    expect(create.mock.calls[0]?.[0].messages[0]?.content).not.toContain('accessPermissions')
    expect(create.mock.calls[0]?.[0].messages[0]?.content).toContain('"gitRepositories":["/workspace"]')
    expect(output.requiredPermissions).toEqual([{ tool: 'run_shell', command: 'git log --oneline -5', workingDirectory: '/workspace' }])
  })

  it('provides configured MCP tools as data and accepts a task-specific tool requirement', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '{"targets":[{"kind":"exact","path":"/workspace","targetType":"directory"}],"requiredPermissions":[{"tool":"mcp","serverId":"server-1","toolName":"search_issues","purpose":"查找最近更新的问题"}],"clarifications":[],"suggestedDirectories":[]}' }] })
    const analyzer = createTaskPreflightModelAnalyzer({} as never, { modelId: 'model-id', modelServiceId: 'service-id' })
    const mcpTools = [{ serverId: 'server-1', serverName: 'Issue Tracker', toolName: 'search_issues', description: 'Search issues', parameters: [{ name: 'query', type: 'string', required: true }] }]
    const output = await analyzer.analyze({
      prompt: '查找最近更新的问题', scheduleSummary: 'daily', deliverySummary: 'desktop',
      authorizedRoots: ['/workspace'], facts: { gitRepositories: [] } as never, tools: [], mcpTools, responseFormat: 'json'
    }, new AbortController().signal)

    expect(output.requiredPermissions).toEqual([{ tool: 'mcp', serverId: 'server-1', toolName: 'search_issues', purpose: '查找最近更新的问题' }])
    expect(create.mock.calls[0]?.[0].system).toContain('MCP 工具目录')
    expect(create.mock.calls[0]?.[0].messages[0]?.content).toContain('"serverName":"Issue Tracker"')
    expect(create.mock.calls[0]?.[0].messages[0]?.content).not.toContain('descriptorHash')
  })

  it('states the preflight task and delivery standard for every output field', async () => {
    const prompt = '总结一下昨天合并进 main 分支，并推送 GitHub 的所有内容。'
    create.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({
      targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }],
      requiredPermissions: [{ tool: 'run_shell', command: 'git log --oneline -5', workingDirectory: '/workspace' }],
      clarifications: [],
      suggestedDirectories: []
    }) }] })
    const analyzer = createTaskPreflightModelAnalyzer({} as never, { modelId: 'model-id', modelServiceId: 'service-id' })

    const output = await analyzer.analyze({
      prompt, scheduleSummary: 'daily 09:00', deliverySummary: 'none',
      authorizedRoots: ['/workspace'], outputRoot: '/results',
      facts: { gitRepositories: ['/workspace'], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' }] } as never,
      tools: [], responseFormat: 'json'
    }, new AbortController().signal)

    const system = create.mock.calls[0]?.[0].system as string
    expect(system).toContain('任务：依据 task、schedule、delivery、facts，提出目标与具体工具权限。')
    expect(system).toContain('输出一个 JSON 对象')
    expect(system).toContain('targets：实际处理对象')
    expect(system).toContain('requiredPermissions：最小工具权限需求')
    expect(system).toContain('Shell 命令的完整 command 文本、参数、timeout')
    expect(system).toContain('clarifications：仅报必需目标缺失/歧义')
    expect(system).toContain('suggestedDirectories：需用户补授权目录才填写')
    expect(system).toContain('例：读表格→目标+权限。')
    expect(system.length).toBeLessThan(1600)
    expect(system).not.toContain('总结一下昨天合并进 main 分支')
    expect(system).not.toContain('git log')
    expect(system).not.toContain(prompt)
    expect(system).not.toContain('"/workspace"')
    expect(output).toMatchObject({ targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }], requiredPermissions: [{ tool: 'run_shell', command: 'git log --oneline -5' }], clarifications: [] })
  })

  it('uses host facts to locate local data and separates missing capabilities from unclear targets', async () => {
    const prompt = '总结一下昨天合并进main分支，并推送github的所有内容。'
    create.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({
      targets: [],
      requiredPermissions: [],
      clarifications: [{ reference: prompt, reasonCode: 'target_missing' }],
      suggestedDirectories: []
    }) }] })
    const analyzer = createTaskPreflightModelAnalyzer({} as never, { modelId: 'model-id', modelServiceId: 'service-id' })

    await analyzer.analyze({
      prompt, scheduleSummary: 'daily 09:00', deliverySummary: 'none', authorizedRoots: ['/tmp/materials'], outputRoot: '/tmp/results',
      facts: { gitRepositories: [], entries: [] } as never, tools: [], responseFormat: 'json'
    }, new AbortController().signal)

    const system = create.mock.calls[0]?.[0].system as string
    expect(system).toContain('本机事实源从 facts 定位')
    expect(system).toContain('需要工具时逐项申报 requiredPermissions')
    expect(system).toContain('用宽泛权限代替澄清')
  })

  it('rejects missing model selection, provider errors, and malformed JSON', async () => {
    const noSelection = createTaskPreflightModelAnalyzer({} as never, {})
    await expect(noSelection.analyze({} as never, new AbortController().signal)).rejects.toThrow('PREFLIGHT_MODEL_NOT_SELECTED')
    vi.mocked(resolveLlmCredentialsForPair).mockResolvedValueOnce({ error: 'provider unavailable' })
    const providerError = createTaskPreflightModelAnalyzer({} as never, { modelId: 'model-id', modelServiceId: 'service-id' })
    await expect(providerError.analyze({} as never, new AbortController().signal)).rejects.toThrow('provider unavailable')
    create.mockResolvedValueOnce({ content: [{ type: 'text', text: 'not json' }] })
    const malformed = createTaskPreflightModelAnalyzer({} as never, { modelId: 'model-id', modelServiceId: 'service-id' })
    await expect(malformed.analyze({} as never, new AbortController().signal)).rejects.toThrow('PREFLIGHT_MODEL_INVALID_JSON')
  })
})
