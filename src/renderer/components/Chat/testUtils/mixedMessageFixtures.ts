import type { Message, ToolCallRecord } from '../../../../shared/domainTypes'

const MD_SNIPPET = [
  '## Summary',
  '',
  'Here is a table:',
  '',
  '| Name | Value |',
  '| --- | --- |',
  '| alpha | 1 |',
  '| beta | 2 |',
  '',
  'Inline `code` and a fence:',
  '',
  '```ts',
  'export function add(a: number, b: number) { return a + b }',
  '```',
  '',
  'Math: $E=mc^2$'
].join('\n')

function toolCallsFor(seed: number): ToolCallRecord[] {
  const now = 1_700_000_000_000 + seed * 1000
  return [
    {
      id: `tool-${seed}-r`,
      toolName: 'read_file',
      input: { path: `src/file-${seed}.ts` },
      status: 'completed',
      riskLevel: 'low',
      startedAt: now,
      completedAt: now + 10,
      result: { success: true, data: `// file ${seed}\n` + 'x'.repeat(120) }
    },
    {
      id: `tool-${seed}-l`,
      toolName: 'list_directory',
      input: { path: `src/${seed}` },
      status: 'completed',
      riskLevel: 'low',
      startedAt: now + 20,
      completedAt: now + 30,
      result: {
        success: true,
        data: Array.from({ length: 8 }, (_, i) => ({ name: `f${i}.ts`, type: 'file' as const }))
      }
    }
  ]
}

/** 可复现混合消息 fixture：纯文本 / Markdown / 工具批次交错。 */
export function buildMixedMessageFixture(count: number, sessionId = 'perf-session'): Message[] {
  const messages: Message[] = []
  for (let i = 0; i < count; i++) {
    const ts = 1_700_000_000_000 + i * 2000
    if (i % 2 === 0) {
      messages.push({
        id: `u-${i}`,
        sessionId,
        role: 'user',
        content: `User question #${i}: please inspect the workspace and summarize.`,
        timestamp: ts,
        status: 'sent',
        schemaVersion: 1
      })
      continue
    }

    const kind = i % 6
    if (kind === 1) {
      messages.push({
        id: `a-${i}`,
        sessionId,
        role: 'assistant',
        content: `Plain reply #${i}: done.`,
        timestamp: ts,
        status: 'completed',
        schemaVersion: 1,
        contentSegments: [{ content: `Plain reply #${i}: done.`, startTime: ts, endTime: ts + 1 }]
      })
    } else if (kind === 3) {
      const content = `${MD_SNIPPET}\n\n<!-- msg ${i} -->`
      messages.push({
        id: `a-${i}`,
        sessionId,
        role: 'assistant',
        content,
        timestamp: ts,
        status: 'completed',
        schemaVersion: 1,
        contentSegments: [{ content, startTime: ts, endTime: ts + 1 }]
      })
    } else {
      const tools = toolCallsFor(i)
      messages.push({
        id: `a-${i}`,
        sessionId,
        role: 'assistant',
        content: `Tool-backed reply #${i}`,
        timestamp: ts,
        status: 'completed',
        schemaVersion: 1,
        contentSegments: [{ content: `Tool-backed reply #${i}`, startTime: ts + 40, endTime: ts + 50 }],
        toolCalls: tools
      })
    }
  }
  return messages
}

export function appendStreamingTail(messages: Message[]): Message[] {
  const ts = Date.now()
  return [
    ...messages,
    {
      id: 'stream-tail',
      sessionId: messages[0]?.sessionId ?? 'perf-session',
      role: 'assistant',
      content: 'Streaming chunk 0',
      timestamp: ts,
      status: 'streaming',
      schemaVersion: 1,
      contentSegments: [{ content: 'Streaming chunk 0', startTime: ts }]
    }
  ]
}
