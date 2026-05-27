import { describe, expect, it } from 'vitest'
import { feishuEventConnectionStateLabel, formatFeishuEventStatusText } from './feishuEventLabels'

describe('feishuEventLabels', () => {
  it('maps connection states to Chinese', () => {
    expect(feishuEventConnectionStateLabel('stopped')).toBe('已停止')
    expect(feishuEventConnectionStateLabel('connecting')).toBe('正在连接')
    expect(feishuEventConnectionStateLabel('connected')).toBe('已连接')
    expect(feishuEventConnectionStateLabel('error')).toBe('出错')
  })

  it('formats event status line in Chinese', () => {
    expect(formatFeishuEventStatusText({ state: 'connecting', processedCount: 3 })).toBe(
      '正在连接 · 已处理 3'
    )
  })
})
