import { describe, expect, it, vi } from 'vitest'
import {
  clearFeishuRemoteProgress,
  formatFeishuRemoteProgressPrefix,
  publishFeishuRemoteProgress
} from './feishuRemoteProgress'

vi.mock('./feishuReply', () => ({
  replyFeishuText: vi.fn().mockResolvedValue(undefined)
}))

import { replyFeishuText } from './feishuReply'

describe('feishuRemoteProgress', () => {
  it('publishes unique progress and dedupes repeats', async () => {
    const runner = {} as import('./larkCliRunner').LarkCliRunner
    await publishFeishuRemoteProgress(runner, 'm1', 's1', '正在打开网页')
    await publishFeishuRemoteProgress(runner, 'm1', 's1', '正在打开网页')
    expect(replyFeishuText).toHaveBeenCalledTimes(1)
    expect(formatFeishuRemoteProgressPrefix('s1')).toContain('正在打开网页')
    clearFeishuRemoteProgress('s1')
    expect(formatFeishuRemoteProgressPrefix('s1')).toBe('')
  })
})
