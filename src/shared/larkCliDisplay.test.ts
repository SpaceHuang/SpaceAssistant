import { describe, expect, it } from 'vitest'
import {
  isLarkCliWriteOperation,
  redactLarkCliArgsForDisplay,
  summarizeLarkCliConfirmInput
} from './larkCliDisplay'

describe('larkCliDisplay', () => {
  it('detects write operations', () => {
    expect(isLarkCliWriteOperation(['message', 'send'])).toBe(true)
    expect(isLarkCliWriteOperation(['message', 'search'])).toBe(false)
    expect(isLarkCliWriteOperation(['api', 'POST', '/x'])).toBe(true)
    expect(isLarkCliWriteOperation(['api', 'GET', '/x'])).toBe(false)
  })

  it('redacts secrets in display command', () => {
    expect(redactLarkCliArgsForDisplay(['auth', 'login', '--token', 'abc'])).toBe(
      'lark-cli auth login --token ***'
    )
  })

  it('summarizes confirm input with write hint', () => {
    const summary = summarizeLarkCliConfirmInput({
      args: ['message', 'send', '--chat-id', 'oc_x', '--text', 'hi']
    })
    expect(summary.headline).toBe('飞书 message send')
    expect(summary.command).toContain('lark-cli message send')
    expect(summary.isWriteOperation).toBe(true)
    expect(summary.hint).toContain('修改飞书数据')
  })
})
