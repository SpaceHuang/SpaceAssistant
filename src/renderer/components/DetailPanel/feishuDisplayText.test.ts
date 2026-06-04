import { beforeEach, describe, expect, it } from 'vitest'
import { changeAppLocale } from '../../i18n/localeSync'
import { formatFeishuErrorTooltip, resolveFeishuDisplayText } from './feishuDisplayText'
import type { FeishuRemoteDisplayStatus } from './feishuRemoteDisplayStatus'

function stoppedStatus(over: Partial<FeishuRemoteDisplayStatus> = {}): FeishuRemoteDisplayStatus {
  return {
    displayState: 'stopped',
    subtextKey: 'serviceStopped',
    startEnabled: true,
    stopEnabled: false,
    eventStatus: { state: 'stopped', processedCount: 0 },
    health: null,
    ...over
  }
}

describe('feishuDisplayText', () => {
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
  })

  it('translates stopped label and subtext in zh-CN', () => {
    const text = resolveFeishuDisplayText(stoppedStatus())
    expect(text.label).toBe('已停止')
    expect(text.subtext).toBe('服务已停止')
  })

  it('translates stopped label and subtext in en-US', async () => {
    await changeAppLocale('en-US')
    const text = resolveFeishuDisplayText(stoppedStatus())
    expect(text.label).toBe('Stopped')
    expect(text.subtext).toBe('Service stopped')
  })

  it('formats error tooltip with locale-aware timestamps', async () => {
    await changeAppLocale('en-US')
    const tooltip = formatFeishuErrorTooltip({
      lastError: 'timeout',
      processedCount: 2,
      startedAt: Date.UTC(2026, 0, 15, 8, 0, 0)
    })
    expect(tooltip).toContain('timeout')
    expect(tooltip).toContain('Processed: 2')
    expect(tooltip).toContain('Started:')
  })
})
