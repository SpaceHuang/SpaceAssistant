import { describe, expect, it } from 'vitest'
import { registerInboundFeishuAttachments } from './feishuAttachmentRegistry'

describe('registerInboundFeishuAttachments', () => {
  it('为入站消息附件分配请求内编号且不把路径放进模型参数', () => {
    expect(registerInboundFeishuAttachments({
      messageId: 'msg-1',
      chatId: 'chat-1',
      chatType: 'p2p',
      senderOpenId: 'owner',
      content: '请读附件',
      createTime: '1',
      mentionsBot: true,
      attachments: [
        { kind: 'image', localPath: '/user/feishu-media/cache/msg-1/pic.png', fileName: '../pic.png', mimeType: 'image/png' },
        { kind: 'file', localPath: 'relative/file.txt', fileName: 'file.txt' }
      ]
    })).toEqual([{
      id: 'attachment-1',
      messageId: 'msg-1',
      localPath: '/user/feishu-media/cache/msg-1/pic.png',
      fileName: 'pic.png',
      mimeType: 'image/png'
    }])
  })
})
