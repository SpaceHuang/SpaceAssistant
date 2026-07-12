import { describe, expect, it } from 'vitest'
import {
  formatRemoteOutboundMessage,
  isRemoteProcessingPlaceholder,
  progressReplyDedupeKey,
  REMOTE_PROCESSING_PLACEHOLDERS,
  stripSessionSuffix
} from './remoteOutboundFormat'

const SESSION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

describe('remoteOutboundFormat', () => {
  it('placeholder texts do not get suffix', () => {
    for (const text of REMOTE_PROCESSING_PLACEHOLDERS) {
      expect(isRemoteProcessingPlaceholder(text)).toBe(true)
      expect(formatRemoteOutboundMessage(text, SESSION_ID)).toBe(text)
    }
  })

  it('custom fallback text gets suffix when not in placeholder table', () => {
    const body = '正在分析…'
    expect(isRemoteProcessingPlaceholder(body)).toBe(false)
    expect(formatRemoteOutboundMessage(body, SESSION_ID)).toBe(`${body} 会话$${SESSION_ID}$`)
  })

  it('appends suffix to progress and summary bodies', () => {
    const body = '【进度】读取 config.json'
    expect(formatRemoteOutboundMessage(body, SESSION_ID)).toBe(`${body} 会话$${SESSION_ID}$`)
  })

  it('does not stack duplicate suffix', () => {
    const withSuffix = `hello 会话$${SESSION_ID}$`
    expect(formatRemoteOutboundMessage(withSuffix, SESSION_ID)).toBe(`hello 会话$${SESSION_ID}$`)
  })

  it('stripSessionSuffix removes trailing session marker', () => {
    const text = `【进度】读取文件 会话$${SESSION_ID}$`
    expect(stripSessionSuffix(text)).toBe('【进度】读取文件')
  })

  it('progressReplyDedupeKey ignores suffix differences', () => {
    const base = '【进度】读取 config.json'
    const withSuffix = `${base} 会话$${SESSION_ID}$`
    expect(progressReplyDedupeKey(base)).toBe(progressReplyDedupeKey(withSuffix))
  })
})
