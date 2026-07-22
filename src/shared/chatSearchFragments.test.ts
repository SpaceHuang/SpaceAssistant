import { describe, expect, it } from 'vitest'
import { projectMarkdownForSearch } from '../renderer/services/markdownSearchProjection'
import type { Message, ToolCallRecord } from './domainTypes'
import {
  buildFragmentId,
  buildSearchFragmentsFromMessage,
  type SearchFragment
} from './chatSearchFragments'

const mockT = (key: string, options?: Record<string, unknown>): string => {
  if (key === 'tool.labels.readFile') return '读取文件'
  if (key === 'tool.labels.grep.withPattern') return `grep ${String(options?.pattern ?? '')}`
  return key
}

function userMsg(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-user',
    sessionId: 's1',
    role: 'user',
    content: 'Find the config file please',
    timestamp: 1,
    status: 'sent',
    schemaVersion: 1,
    ...over
  }
}

function assistantMsg(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-asst',
    sessionId: 's1',
    role: 'assistant',
    content: 'Here is the answer.',
    timestamp: 2,
    status: 'completed',
    schemaVersion: 1,
    contentSegments: [{ content: 'Here is the answer.', startTime: 2, endTime: 3 }],
    ...over
  }
}

describe('buildSearchFragmentsFromMessage', () => {
  it('creates a user-content fragment', () => {
    const message = userMsg()
    const fragments = buildSearchFragmentsFromMessage(message, { kind: 'persisted', sequence: 1 })

    const userFragment = fragments.find((f) => f.source.kind === 'user-content')
    expect(userFragment).toBeDefined()
    expect(userFragment?.renderStrategy).toBe('anchored-text')
    if (userFragment?.renderStrategy === 'anchored-text') {
      expect(userFragment.searchableText).toBe('Find the config file please')
    }
    expect(userFragment?.messageId).toBe('msg-user')
    expect(userFragment?.order).toEqual({ kind: 'persisted', sequence: 1 })
  })

  it('creates assistant markdown plain-text searchable fragments', () => {
    const markdown = 'Hello **world** with `code` and $E=mc^2$'
    const message = assistantMsg({
      content: markdown,
      contentSegments: [{ content: markdown, startTime: 2, endTime: 3 }]
    })
    const fragments = buildSearchFragmentsFromMessage(
      message,
      { kind: 'persisted', sequence: 2 },
      { projectMarkdown: projectMarkdownForSearch }
    )

    const textFragments = fragments.filter(
      (f): f is Extract<SearchFragment, { renderStrategy: 'anchored-text' }> =>
        f.source.kind === 'assistant-markdown-text'
    )
    expect(textFragments.length).toBeGreaterThan(0)
    expect(textFragments.some((f) => f.searchableText.includes('Hello'))).toBe(true)

    const codeFragments = fragments.filter((f) => f.source.kind === 'assistant-code')
    expect(codeFragments.some((f) => f.renderStrategy === 'code-source' && f.searchableText === 'code')).toBe(true)

    const mathFragments = fragments.filter((f) => f.source.kind === 'assistant-math')
    expect(mathFragments.some((f) => f.renderStrategy === 'math-source' && f.searchableText === 'E=mc^2')).toBe(true)
  })

  it('creates thinking, skill, and tool fragments when present', () => {
    const tool: ToolCallRecord = {
      id: 'tool-1',
      toolName: 'read_file',
      input: { path: 'src/config.ts' },
      status: 'completed',
      riskLevel: 'low',
      result: { success: true, data: 'export const x = 1' }
    }
    const message = assistantMsg({
      content: 'Done.',
      contentSegments: [{ content: 'Done.', startTime: 2, endTime: 3 }],
      thinking: {
        content: 'Need to inspect config',
        isVisible: true,
        startTime: 1,
        segments: [{ content: 'Need to inspect config', startTime: 1, endTime: 2 }]
      },
      skillHints: [{ id: 'skill-1', text: 'Using workspace skill', shownAt: 1 }],
      toolCalls: [tool]
    })

    const fragments = buildSearchFragmentsFromMessage(message, { kind: 'persisted', sequence: 3 }, { t: mockT })

    expect(fragments.some((f) => f.source.kind === 'thinking')).toBe(true)
    expect(fragments.some((f) => f.source.kind === 'skill')).toBe(true)
    expect(fragments.some((f) => f.source.kind === 'tool-label')).toBe(true)
    expect(fragments.some((f) => f.source.kind === 'tool-input')).toBe(true)
    expect(fragments.some((f) => f.source.kind === 'tool-result')).toBe(true)

    const thinking = fragments.find((f) => f.source.kind === 'thinking')
    if (thinking?.renderStrategy === 'anchored-text') {
      expect(thinking.searchableText).toContain('Need to inspect config')
    }

    const toolLabel = fragments.find((f) => f.source.kind === 'tool-label')
    if (toolLabel?.renderStrategy === 'anchored-text') {
      expect(toolLabel.searchableText).toBe('config.ts')
    }
  })

  it('indexes shell output using the text shown by the dedicated output view', () => {
    const message = assistantMsg({
      toolCalls: [{
        id: 'shell-1', toolName: 'run_shell', input: { command: 'pwd' }, status: 'completed', riskLevel: 'low',
        result: { success: true, data: { stdout: 'stdout needle', stderr: 'stderr warning', exitCode: 1 } }
      }]
    })
    const result = buildSearchFragmentsFromMessage(message, { kind: 'persisted', sequence: 4 })
      .find((fragment) => fragment.source.kind === 'tool-result')
    expect(result?.searchableText).toBe('stdout needle\n退出码 1\nstderr warning')
  })

  it('prefers visible shell stderr over hidden failure error and normalizes terminal output', () => {
    const message = assistantMsg({ toolCalls: [{
      id: 'shell-2', toolName: 'run_shell', input: { command: 'test' }, status: 'failed', riskLevel: 'low',
      result: { success: false, error: 'hidden failure', data: { stdout: '\u001b[31mout\u001b[0m\r\n', stderr: 'visible needle', exitCode: 1 } }
    }] })
    const result = buildSearchFragmentsFromMessage(message, { kind: 'persisted', sequence: 5 })
      .find((fragment) => fragment.source.kind === 'tool-result')
    expect(result?.searchableText).toContain('visible needle')
    expect(result?.searchableText).not.toContain('hidden failure')
    expect(result?.searchableText).toContain('退出码 1')
  })

  it('does not index an exit-code label when exitCode is absent or invalid', () => {
    for (const exitCode of [undefined, null, '1', Number.NaN]) {
      const message = assistantMsg({ toolCalls: [{
        id: `shell-${String(exitCode)}`, toolName: 'run_shell', input: {}, status: 'completed', riskLevel: 'low',
        result: { success: true, data: { stdout: 'only output', stderr: '', exitCode } }
      }] })
      const result = buildSearchFragmentsFromMessage(message, { kind: 'persisted', sequence: 6 })
        .find((fragment) => fragment.source.kind === 'tool-result')
      expect(result?.searchableText).toBe('only output')
    }
  })

  it('uses ansiText scrollback as searchable output but excludes serialized-only payloads', () => {
    const make = (data: unknown) => assistantMsg({ toolCalls: [{
      id: 'scrollback', toolName: 'run_shell', input: {}, status: 'completed', riskLevel: 'low',
      result: { success: true, data }
    }] })
    const ansi = buildSearchFragmentsFromMessage(make({ terminalScrollback: { ansiText: '\u001b[32mansi needle\u001b[0m', cols: 80, rows: 2 } }), { kind: 'persisted', sequence: 7 })
      .find((fragment) => fragment.source.kind === 'tool-result')
    expect(ansi?.searchableText).toBe('ansi needle')
    const serialized = buildSearchFragmentsFromMessage(make({ terminalScrollback: { serialized: 'serialized needle', cols: 80, rows: 2 } }), { kind: 'persisted', sequence: 8 })
      .find((fragment) => fragment.source.kind === 'tool-result')
    expect(serialized).toBeUndefined()
  })

  it('generates the same fragmentId for the same messageId and source identity', () => {
    const source = { kind: 'user-content' as const }
    const a = buildFragmentId('msg-1', source)
    const b = buildFragmentId('msg-1', source)
    const c = buildFragmentId('msg-2', source)

    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toContain('msg-1')
  })
})
