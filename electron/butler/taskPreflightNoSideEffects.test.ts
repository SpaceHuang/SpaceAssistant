import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTaskPreflightModelAnalyzer } from './taskPreflightModelAnalyzer'
import { resolveLlmCredentialsForPair } from '../llmServiceResolver'
import { createAnthropicClient } from '../anthropicClientFactory'

const effects = vi.hoisted(() => ({
  readFile: vi.fn(), writeFile: vi.fn(), editFile: vi.fn(), listDirectory: vi.fn(), grep: vi.fn(),
  shell: vi.fn(), script: vi.fn(), browser: vi.fn(), mcpFactory: vi.fn(), delivery: vi.fn(),
  spawn: vi.fn(), exec: vi.fn(), execFile: vi.fn(), fsReadFile: vi.fn(), fsWriteFile: vi.fn(), fetch: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: effects.spawn, exec: effects.exec, execFile: effects.execFile }))
vi.mock('node:fs/promises', () => ({ readFile: effects.fsReadFile, writeFile: effects.fsWriteFile }))
vi.mock('../llmServiceResolver', () => ({ resolveLlmCredentialsForPair: vi.fn() }))
vi.mock('../anthropicClientFactory', () => ({ createAnthropicClient: vi.fn() }))
vi.mock('../tools/builtinExecutors', () => ({
  readFileExecutor: { execute: effects.readFile }, writeFileExecutor: { execute: effects.writeFile },
  editFileExecutor: { execute: effects.editFile }, listDirectoryExecutor: { execute: effects.listDirectory },
  grepExecutor: { execute: effects.grep }, runScriptExecutor: { execute: effects.script }
}))
vi.mock('../tools/runShellExecutor', () => ({ runShellExecutor: { execute: effects.shell } }))
vi.mock('../tools/runScriptRegisteredTool', () => ({ createRunScriptRegisteredTool: effects.script }))
vi.mock('../tools/browserExecutor', () => ({ browserExecutor: { execute: effects.browser } }))
vi.mock('../mcp/mcpToolExecutor', () => ({ createMcpToolExecutor: effects.mcpFactory }))
vi.mock('./butlerDelivery', () => ({ deliverTaskResult: effects.delivery }))

describe('task preflight side-effect boundary', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('records filesystem, process, MCP, network, browser, and delivery intents without entering real executors', async () => {
    const names = [
      'read_file', 'write_file', 'edit_file', 'list_directory', 'grep', 'run_shell', 'run_script',
      'mcp_issue_search', 'browser', 'feishu_send'
    ]
    const tools = names.map((name) => ({ name, description: `${name} tool`, inputSchema: { type: 'object' } }))
    const calls = names.map((name, index) => ({ id: `call-${index}`, name, input: { target: `/workspace/${name}`, arg: index } }))
    const modelCreate = vi.fn()
      .mockResolvedValueOnce({ content: calls.map((call) => ({ type: 'tool_use', ...call })), stop_reason: 'tool_use', usage: { output_tokens: 50 } })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"targets":[],"requiredPermissions":[],"clarifications":[],"suggestedDirectories":[]}' }], stop_reason: 'end_turn', usage: { output_tokens: 20 } })
    vi.mocked(resolveLlmCredentialsForPair).mockResolvedValue({
      model: { id: 'model-id', name: 'provider-model', enabled: true } as never,
      serviceId: 'service-id', providerModelName: 'provider-model', baseUrl: 'https://model.test', getApiKey: async () => 'api-key'
    })
    vi.mocked(createAnthropicClient).mockReturnValue({ messages: { create: modelCreate } } as never)

    vi.stubGlobal('fetch', effects.fetch)
    const analyzer = createTaskPreflightModelAnalyzer({} as never, { modelId: 'model-id', modelServiceId: 'service-id' })

    const result = await analyzer.analyze({
      prompt: 'Perform the requested task', scheduleSummary: 'daily', deliverySummary: 'none',
      authorizedRoots: ['/workspace'], facts: {} as never, tools, responseFormat: 'json'
    }, new AbortController().signal)

    expect(result.mockTrace?.map((entry) => [entry.toolName, entry.dispatch, entry.resultKind]))
      .toEqual(names.map((name) => [name, 'simulated', 'synthetic']))
    expect([effects.readFile, effects.writeFile, effects.editFile, effects.listDirectory, effects.grep, effects.shell,
      effects.script, effects.browser, effects.mcpFactory, effects.delivery].every((spy) => spy.mock.calls.length === 0)).toBe(true)
    expect(effects.spawn).not.toHaveBeenCalled()
    expect(effects.exec).not.toHaveBeenCalled()
    expect(effects.execFile).not.toHaveBeenCalled()
    expect(effects.fsReadFile).not.toHaveBeenCalled()
    expect(effects.fsWriteFile).not.toHaveBeenCalled()
    expect(effects.fetch).not.toHaveBeenCalled()
  })
})
