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
