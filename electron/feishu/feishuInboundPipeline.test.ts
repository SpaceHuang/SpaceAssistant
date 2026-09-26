import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEISHU_CONFIG } from '../../src/shared/feishuTypes'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { parseCompactInboundEvent, shouldAcceptInbound } from './feishuInboundParser'
import { prepareInboundFeishuAttachments } from './feishuInboundAttachmentDownload'
import { registerInboundFeishuAttachments } from './feishuAttachmentRegistry'
import { filterBuiltinToolsForApi } from '../toolsConfigRuntime'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('飞书 compact 事件附件入站链路', () => {
  it('解析 CLI 字段后完成 owner 接受、附件下载登记和工具暴露', async () => {
    const rawEvent = {
      message_id: 'om_compact_1', chat_id: 'oc_chat_1', chat_type: 'p2p',
      sender_id: 'ou_owner', message_type: 'image',
      content: '/sa 请读取这条消息的附件', create_time: '1000'
    }
    const msg = parseCompactInboundEvent(rawEvent)
    expect(msg).toMatchObject({ messageId: rawEvent.message_id, chatId: rawEvent.chat_id, senderOpenId: rawEvent.sender_id, msgType: 'image' })
    expect(msg && shouldAcceptInbound(msg, { ...DEFAULT_FEISHU_CONFIG, remoteSenderAllowlist: ['ou_owner'] }).accept).toBe(true)

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-inbound-pipeline-'))
    tempDirs.push(root)
    const messageRoot = path.join(root, 'cache', rawEvent.message_id)
    const downloadedFile = path.join(messageRoot, 'lark-im-resources', 'notes.txt')
    await fs.mkdir(path.dirname(downloadedFile), { recursive: true })
    await fs.writeFile(downloadedFile, 'attachment body')
    const runner = { run: vi.fn().mockResolvedValue({
      exitCode: 0, timedOut: false, stderr: '',
      stdout: JSON.stringify({ messages: [{
        message_id: rawEvent.message_id,
        resources: [{ message_id: rawEvent.message_id, type: 'file', local_path: './lark-im-resources/notes.txt', size_bytes: 15 }]
      }] })
    }) }
    const prepared = await prepareInboundFeishuAttachments(
      runner as never, msg!, path.join(root), { ...DEFAULT_FEISHU_CONFIG, remoteSenderAllowlist: ['ou_owner'] }
    )
    expect(runner.run).toHaveBeenCalledOnce()
    const attachments = registerInboundFeishuAttachments(prepared)
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({ id: 'attachment-1', messageId: rawEvent.message_id, localPath: downloadedFile })

    const tools = filterBuiltinToolsForApi(
      DEFAULT_TOOLS_CONFIG,
      { ...DEFAULT_FEISHU_CONFIG, enabled: true },
      undefined,
      { source: 'feishu', messageId: rawEvent.message_id, confirmPolicy: 'im_confirm', feishuAttachments: attachments }
    )
    expect(tools.find((tool) => tool.name === 'read_feishu_attachment')?.input_schema).toMatchObject({
      properties: { attachmentId: { enum: ['attachment-1'] } }
    })
  })
})
