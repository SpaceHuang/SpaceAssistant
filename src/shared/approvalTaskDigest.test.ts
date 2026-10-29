import { describe, expect, it } from 'vitest'
import { buildApprovalConversationContext, buildApprovalTaskIdentity } from './approvalTaskDigest'

describe('buildApprovalConversationContext', () => {
  it('keeps the prior user request and assistant option that a short follow-up refers to', () => {
    const context = buildApprovalConversationContext([
      { id: 'old-user', role: 'user', content: 'Unrelated earlier request' },
      { id: 'target-user', role: 'user', content: '移除 wiki 中的 AGENTS.md（SpaceAssistant 仓库）摘要记录' },
      { id: 'proposal', role: 'assistant', content: '可以把该页标记为废弃，保留历史版本。' },
      { id: 'continue', role: 'user', content: '继续' },
      { id: 'current', role: 'user', content: '标记为废弃吧' }
    ], 'current')

    expect(context).toContain('[用户] 移除 wiki 中的 AGENTS.md')
    expect(context).toContain('[助手] 可以把该页标记为废弃')
    expect(context).not.toContain('标记为废弃吧')
    expect(context).not.toContain('[用户] 继续')
    expect(context).not.toContain('Unrelated earlier request')
  })

  it('bounds excerpts and excludes tool/system content', () => {
    const context = buildApprovalConversationContext([
      { id: 'tool', role: 'tool', content: 'tool payload that must not enter approval context' },
      { id: 'user', role: 'user', content: 'x'.repeat(2000) },
      { id: 'assistant', role: 'assistant', content: `${'y'.repeat(1600)} the proposed option is to mark the page deprecated. ${'z'.repeat(300)}` },
      { id: 'system', role: 'system', content: 'system prompt' },
      { id: 'current', role: 'user', content: 'continue' }
    ], 'current')

    expect(context).toBeDefined()
    expect(context!.length).toBeLessThan(2500)
    expect(context).toContain('该条消息已截断')
    expect(context).toContain('mark the page deprecated')
    expect(context).not.toContain('tool payload')
    expect(context).not.toContain('system prompt')
  })

  it('returns no context if current user message cannot be located', () => {
    expect(buildApprovalConversationContext([{ id: 'prior', role: 'user', content: 'task' }], 'missing')).toBeUndefined()
  })

  it('builds an exact cache identity from the raw task and complete selected reference context', () => {
    const makeMessages = (assistantContent: string, task: string) => [
      { id: 'prior-user', role: 'user', content: 'Original request' },
      { id: 'prior-assistant', role: 'assistant', content: assistantContent },
      { id: 'current', role: 'user', content: task }
    ]
    const base = buildApprovalTaskIdentity(makeMessages('Update the release notes.', 'continue'), 'current')
    expect(base).not.toBe(buildApprovalTaskIdentity(makeMessages('Delete the draft.', 'continue'), 'current'))
    expect(base).not.toBe(buildApprovalTaskIdentity(makeMessages('Update the release notes.', 'con\ntinue'), 'current'))
    expect(base).toContain('Update the release notes.')
    expect(buildApprovalTaskIdentity([{ id: 'prior', role: 'user', content: 'task' }], 'missing')).toBeUndefined()
  })
})
