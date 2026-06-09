import type { Message, ToolCallRecord } from './domainTypes'
import type { ClaudeChatMessageWithBlocks } from './api'
import { toolIdToOpenAiCompatibleApiToolName } from './toolApiFunctionName'

function toolResultContent(tc: ToolCallRecord): string {
  if (!tc.result) return '(无结果)'
  if (tc.result.success) {
    if (tc.result.data === undefined) return '{}'
    return typeof tc.result.data === 'string' ? tc.result.data : JSON.stringify(tc.result.data)
  }
  return tc.result.error ?? '失败'
}

/** 将本地消息列表转为带 content blocks 的 API 消息（含历史 tool_use / tool_result） */
export function buildClaudeToolChatMessages(messages: Message[]): ClaudeChatMessageWithBlocks[] {
  const out: ClaudeChatMessageWithBlocks[] = []
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    if (m.role === 'assistant' && m.status === 'streaming') continue
    if (m.role === 'user' && m.status === 'queued') continue
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content, id: m.id, timestamp: m.timestamp })
      continue
    }
    if (m.toolCalls?.length) {
      const blocks: unknown[] = []
      if (m.content?.trim()) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls) {
        if (tc.status === 'calling' || tc.status === 'confirming' || tc.status === 'executing') continue
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: toolIdToOpenAiCompatibleApiToolName(tc.toolName),
          input: tc.input
        })
      }
      if (blocks.length === 0) {
        out.push({ role: 'assistant', content: m.content || ' ', id: m.id, timestamp: m.timestamp })
        continue
      }
      out.push({ role: 'assistant', content: blocks, id: m.id, timestamp: m.timestamp })
      const results: unknown[] = []
      for (const tc of m.toolCalls) {
        if (tc.status === 'calling' || tc.status === 'confirming' || tc.status === 'executing') continue
        results.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: toolResultContent(tc)
        })
      }
      if (results.length) out.push({ role: 'user', content: results })
    } else {
      out.push({ role: 'assistant', content: m.content, id: m.id, timestamp: m.timestamp })
    }
  }
  return out
}
