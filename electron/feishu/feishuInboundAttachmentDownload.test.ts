import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEISHU_CONFIG, type FeishuInboundMessage } from '../../src/shared/feishuTypes'
import { downloadInboundFeishuAttachments, prepareInboundFeishuAttachments } from './feishuInboundAttachmentDownload'

const tempDirs: string[] = []

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-inbound-download-'))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function message(overrides: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage {
  return {
    messageId: 'om_current', chatId: 'oc_chat', chatType: 'p2p', senderOpenId: 'ou_owner',
    content: '', rawContent: '{"image_key":"img_1"}', createTime: '1', mentionsBot: false,
    msgType: 'image', ...overrides
  }
}

describe('downloadInboundFeishuAttachments', () => {
  it('requests explicit resource download and registers only resources from this message', async () => {
    const root = await makeRoot()
    const messageRoot = path.join(root, 'cache', 'om_current')
    const downloaded = path.join(messageRoot, 'lark-im-resources', 'image.png')
    await fs.mkdir(path.dirname(downloaded), { recursive: true })
    await fs.writeFile(downloaded, 'image')
    const runner = { run: vi.fn().mockResolvedValue({
      exitCode: 0, timedOut: false,
      stdout: JSON.stringify({
        messages: [
          { message_id: 'om_other', resources: [{ message_id: 'om_other', type: 'file', local_path: downloaded }] },
          { message_id: 'om_current', resources: [
            { message_id: 'om_current', type: 'image', local_path: './lark-im-resources/image.png', size_bytes: 5 },
            { message_id: 'om_current', type: 'file', local_path: '/outside/secret.txt', size_bytes: 6 },
            { message_id: 'om_current', type: 'file', local_path: './lark-im-resources/failed', error: true }
          ] }
        ]
      }), stderr: ''
    }) }

    const enriched = await downloadInboundFeishuAttachments(runner as never, message(), root)

    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      args: ['im', '+messages-mget', '--message-ids', 'om_current', '--download-resources', '--no-reactions', '--as', 'bot', '--format', 'json'],
      cwd: messageRoot
    }))
    expect(enriched.attachments).toEqual([{
      kind: 'image', localPath: downloaded, fileName: 'image.png', mimeType: 'image/png'
    }])
  })

  it('skips non-resource messages without making a CLI request', async () => {
    const runner = { run: vi.fn() }
    const original = message({ msgType: 'text', attachments: undefined })
    expect(await downloadInboundFeishuAttachments(runner as never, original, await makeRoot())).toBe(original)
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('does not download resources for an unaccepted sender', async () => {
    const runner = { run: vi.fn() }
    const inbound = message({ content: '/sa 请读取附件内容', senderOpenId: 'ou_stranger' })
    const config = { ...DEFAULT_FEISHU_CONFIG, remoteSenderAllowlist: ['ou_owner'] }
    expect(await prepareInboundFeishuAttachments(runner as never, inbound, await makeRoot(), config)).toBe(inbound)
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('downloads resources after the bound owner submits an accepted post command', async () => {
    const root = await makeRoot()
    const runner = { run: vi.fn().mockResolvedValue({
      exitCode: 0, timedOut: false,
      stdout: JSON.stringify({ messages: [{ message_id: 'om_current', resources: [] }] }), stderr: ''
    }) }
    const inbound = message({ content: '/sa 请读取附件内容', msgType: 'post' })
    const config = { ...DEFAULT_FEISHU_CONFIG, remoteSenderAllowlist: ['ou_owner'] }
    await prepareInboundFeishuAttachments(runner as never, inbound, root, config)
    expect(runner.run).toHaveBeenCalledOnce()
  })

  it('keeps inbound processing viable when the CLI download fails', async () => {
    const original = message()
    const runner = { run: vi.fn().mockResolvedValue({ exitCode: 1, timedOut: false, stdout: '', stderr: 'download denied' }) }
    expect(await downloadInboundFeishuAttachments(runner as never, original, await makeRoot())).toBe(original)
  })

  it('does not register a path that escapes the managed media directory', async () => {
    const root = await makeRoot()
    const runner = { run: vi.fn().mockResolvedValue({
      exitCode: 0, timedOut: false,
      stdout: JSON.stringify({ messages: [{ message_id: 'om_current', resources: [
        { message_id: 'om_current', type: 'file', local_path: '../outside.txt', size_bytes: 10 }
      ] }] }), stderr: ''
    }) }
    const enriched = await downloadInboundFeishuAttachments(runner as never, message({ msgType: 'file' }), root)
    expect(enriched.attachments).toBeUndefined()
  })

  it('removes expired message caches before downloading new resources', async () => {
    const root = await makeRoot()
    const expiredCache = path.join(root, 'cache', 'om_expired')
    await fs.mkdir(expiredCache, { recursive: true })
    const marker = path.join(expiredCache, 'old.txt')
    await fs.writeFile(marker, 'old')
    const expiredAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await fs.utimes(marker, expiredAt, expiredAt)
    await fs.utimes(expiredCache, expiredAt, expiredAt)
    const runner = { run: vi.fn().mockResolvedValue({ exitCode: 1, timedOut: false, stdout: '', stderr: '' }) }
    await downloadInboundFeishuAttachments(runner as never, message(), root)
    await expect(fs.access(expiredCache)).rejects.toThrow()
  })
})
