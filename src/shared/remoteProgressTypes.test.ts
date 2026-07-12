import { describe, expect, it } from 'vitest'
import {
  formatRemoteProgressMessage,
  progressReplyDedupeKey,
  resolveHeartbeatProgressText,
  truncateProgressText
} from './remoteProgressTypes'

describe('remoteProgressTypes', () => {
  it('formats progress message with optional detail', () => {
    expect(
      formatRemoteProgressMessage({ kind: 'tool', label: 'grep src', detail: '搜索中...', publishable: true })
    ).toBe('【进度】grep src\n搜索中...')
  })

  it('truncates long progress text', () => {
    const long = 'a'.repeat(500)
    expect(truncateProgressText(long, 400).length).toBeLessThanOrEqual(400)
  })

  it('resolveHeartbeatProgressText prefers current publishable snapshot', () => {
    const current = { kind: 'tool' as const, label: 'read config.json', publishable: true }
    const last = { kind: 'tool' as const, label: 'old tool', publishable: true }
    const result = resolveHeartbeatProgressText({ current, lastPublishable: last, fallback: '仍在处理…' })
    expect(result.text).toContain('config.json')
    expect(result.publishableUsed).toBe(current)
  })

  it('resolveHeartbeatProgressText falls back to lastPublishable', () => {
    const last = { kind: 'tool' as const, label: 'grep src', publishable: true }
    const result = resolveHeartbeatProgressText({
      current: { kind: 'idle', label: '思考中', publishable: false },
      lastPublishable: last,
      fallback: '仍在处理…'
    })
    expect(result.text).toContain('grep src')
    expect(result.publishableUsed).toBeUndefined()
  })

  it('resolveHeartbeatProgressText uses fallback when no snapshots', () => {
    const result = resolveHeartbeatProgressText({
      current: { kind: 'idle', label: '', publishable: false },
      fallback: '仍在处理…'
    })
    expect(result.text).toBe('仍在处理…')
  })

  it('dedupe key trims whitespace', () => {
    expect(progressReplyDedupeKey('  hello  ')).toBe('hello')
  })
})
