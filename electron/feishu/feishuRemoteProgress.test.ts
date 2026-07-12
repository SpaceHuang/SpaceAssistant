import { describe, expect, it, vi } from 'vitest'
import {
  clearFeishuRemoteProgress,
  formatFeishuRemoteProgressPrefix,
  publishFeishuRemoteProgress
} from './feishuRemoteProgress'
import { updateRemoteProgressSnapshot, clearRemoteProgressSession } from '../remote/remoteProgressStore'

vi.mock('./feishuReply', () => ({
  replyFeishuText: vi.fn().mockResolvedValue(undefined)
}))

import { replyFeishuText } from './feishuReply'

describe('feishuRemoteProgress', () => {
  it('legacy publish still replies via feishu', async () => {
    const runner = {} as import('./larkCliRunner').LarkCliRunner
    await publishFeishuRemoteProgress(runner, 'm1', 's1', '正在打开网页')
    expect(replyFeishuText).toHaveBeenCalledTimes(1)
  })

  it('formatFeishuRemoteProgressPrefix uses coordinator store snapshot', () => {
    updateRemoteProgressSnapshot('s1', {
      kind: 'tool',
      label: '正在打开网页',
      publishable: true
    })
    expect(formatFeishuRemoteProgressPrefix('s1')).toContain('【进度】')
    expect(formatFeishuRemoteProgressPrefix('s1')).toContain('正在打开网页')
    clearRemoteProgressSession('s1')
    clearFeishuRemoteProgress('s1')
    expect(formatFeishuRemoteProgressPrefix('s1')).toBe('')
  })
})
