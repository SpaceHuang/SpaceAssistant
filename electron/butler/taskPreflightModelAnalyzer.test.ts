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
    create.mockResolvedValue({ content: [{ type: 'text', text: '{"targets":[]}' }] })
    const analyzer = createTaskPreflightModelAnalyzer({} as never, { modelId: 'model-id', modelServiceId: 'service-id' })
    const controller = new AbortController()
    await expect(analyzer.analyze({ prompt: 'report', scheduleSummary: 'daily', deliverySummary: 'desktop', authorizedRoots: ['/workspace'], outputRoot: '/results', facts: {} as never, tools: [], responseFormat: 'json' }, controller.signal)).resolves.toEqual({ targets: [] })
    expect(resolveLlmCredentialsForPair).toHaveBeenCalledWith({}, 'model-id', 'service-id')
    expect(createAnthropicClient).toHaveBeenCalledWith('api-key', 'https://model.test')
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'provider-model', messages: [{ role: 'user', content: expect.stringContaining('"task":"report"') }], system: expect.stringContaining('不读取本地文件') }), { signal: controller.signal })
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('tools')
  })

  it('accepts a fenced JSON response from an Anthropic-compatible model', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '```json\n{"targets":[{"kind":"exact","path":"/workspace","targetType":"directory"}],"requiredTools":["run_shell"]}\n```' }] })
    const analyzer = createTaskPreflightModelAnalyzer({} as never, { modelId: 'model-id', modelServiceId: 'service-id' })

    await expect(analyzer.analyze({ prompt: 'inspect Git history', scheduleSummary: 'daily', deliverySummary: 'desktop', authorizedRoots: ['/workspace'], facts: {} as never, tools: [], responseFormat: 'json' }, new AbortController().signal))
      .resolves.toEqual({ targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }], requiredTools: ['run_shell'] })
    expect(create.mock.calls[0]?.[0]).toMatchObject({ max_tokens: 2048 })
  })

  it('identifies a response truncated by the provider token limit', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '{"targets":[' }], stop_reason: 'max_tokens' })
    const analyzer = createTaskPreflightModelAnalyzer({} as never, { modelId: 'model-id', modelServiceId: 'service-id' })

    await expect(analyzer.analyze({} as never, new AbortController().signal)).rejects.toThrow('PREFLIGHT_MODEL_TRUNCATED_RESPONSE')
  })

  it('asks the model to identify exact unclear prompt fragments and structured reasons', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '{"targets":[],"clarifications":[{"reference":"帮我处理一下","reasonCode":"scope_unclear"}]}' }] })
    const analyzer = createTaskPreflightModelAnalyzer({} as never, { modelId: 'model-id', modelServiceId: 'service-id' })
    const output = await analyzer.analyze({ prompt: '帮我处理一下', scheduleSummary: 'daily', deliverySummary: 'desktop', authorizedRoots: ['/workspace'], outputRoot: '/results', facts: { gitRepositories: ['/workspace'] } as never, tools: [], responseFormat: 'json' }, new AbortController().signal)

    expect(output).toMatchObject({ clarifications: [{ reference: '帮我处理一下', reasonCode: 'scope_unclear' }] })
    expect(create.mock.calls[0]?.[0].system).toContain('clarifications')
    expect(create.mock.calls[0]?.[0].messages).toMatchObject([{ content: expect.stringContaining('"outputRoot":"/results"') }])
    expect(create.mock.calls[0]?.[0].messages).toMatchObject([{ content: expect.stringContaining('"authorizedRoots":["/workspace"]') }])
  })

  it('asks the analyzer to propose Shell access for Git history without implying prior user approval', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '{"targets":[{"kind":"exact","path":"/workspace","targetType":"directory"}],"requiredTools":["run_shell"]}' }] })
    const analyzer = createTaskPreflightModelAnalyzer({} as never, { modelId: 'model-id', modelServiceId: 'service-id' })
    const output = await analyzer.analyze({
      prompt: '总结昨天合并到 main 的提交', scheduleSummary: 'daily', deliverySummary: 'desktop',
      authorizedRoots: ['/workspace'], outputRoot: '/results',
      facts: { gitRepositories: ['/workspace'] } as never, tools: [], responseFormat: 'json'
    }, new AbortController().signal)

    expect(create.mock.calls[0]?.[0].system).toContain('不得声称用户已经批准')
    expect(create.mock.calls[0]?.[0].system).toContain('Git 历史')
    expect(create.mock.calls[0]?.[0].system).toContain('run_shell')
    expect(create.mock.calls[0]?.[0].messages[0]?.content).not.toContain('accessPermissions')
    expect(create.mock.calls[0]?.[0].messages[0]?.content).toContain('"gitRepositories":["/workspace"]')
    expect(output.requiredTools).toEqual(['run_shell'])
  })

  it('gives Git history preflight a concrete repository and local-shell permission example', async () => {
    const prompt = '总结一下昨天合并进 main 分支，并推送 GitHub 的所有内容。'
    create.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({
      targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }],
      requiredTools: ['run_shell'],
      clarifications: []
    }) }] })
    const analyzer = createTaskPreflightModelAnalyzer({} as never, { modelId: 'model-id', modelServiceId: 'service-id' })

    const output = await analyzer.analyze({
      prompt, scheduleSummary: 'daily 09:00', deliverySummary: 'none',
      authorizedRoots: ['/workspace'], outputRoot: '/results',
      facts: { gitRepositories: ['/workspace'], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' }] } as never,
      tools: [], responseFormat: 'json'
    }, new AbortController().signal)

    const system = create.mock.calls[0]?.[0].system as string
    expect(system).toContain('facts.gitRepositories 恰有一个仓库')
    expect(system).toContain('过去时的“已推送/推送了什么”是查询历史，不是本次执行 git push')
    expect(system).toContain('本地 refs/reflog 只能作为本机记录，不代表 GitHub 服务器时间')
    expect(system).toContain('不因出现 GitHub 一词就要求联网')
    expect(system).toContain('{"targets":[{"kind":"exact","path":"/workspace","targetType":"directory"}],"requiredTools":["run_shell"],"clarifications":[]}')
    expect(system).toContain('没有明确要求写入文件时，不生成 output target')
    expect(output).toMatchObject({ targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }], requiredTools: ['run_shell'], clarifications: [] })
  })

  it('treats a Git history request as a clear target when no repository is present in authorized facts', async () => {
    const prompt = '总结一下昨天合并进main分支，并推送github的所有内容。'
    create.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({
      targets: [],
      clarifications: [{ reference: prompt, reasonCode: 'git_repository_not_found' }]
    }) }] })
    const analyzer = createTaskPreflightModelAnalyzer({} as never, { modelId: 'model-id', modelServiceId: 'service-id' })

    await analyzer.analyze({
      prompt, scheduleSummary: 'daily 09:00', deliverySummary: 'none', authorizedRoots: ['/tmp/materials'], outputRoot: '/tmp/results',
      facts: { gitRepositories: [], entries: [] } as never, tools: [], responseFormat: 'json'
    }, new AbortController().signal)

    const system = create.mock.calls[0]?.[0].system as string
    expect(system).toContain('Git 历史查询是明确的任务范围，不需要普通文件名或目录名')
    expect(system).toContain('git_repository_not_found')
    expect(system).toContain('authorizedRoots 为空时 targets=[]、requiredTools=[]')
    expect(system).toContain('capability_not_authorized 说明用户需要添加目标仓库目录')
    expect(system).toContain('不得判为 missing_location')
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
