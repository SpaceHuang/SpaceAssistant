import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { readFeishuAttachmentExecutor } from './readFeishuAttachmentExecutor'
import type { ToolExecutionContext } from './types'
import { probeFeishuMediaTarget } from '../confirmation/extractors/feishuMediaFacts'
import { buildReadExecutionPermit } from '../confirmation/readExecutionPermit'
import { MAX_FEISHU_ATTACHMENT_BYTES, type RegisteredFeishuAttachment } from '../feishu/feishuAttachmentRegistry'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'

const roots: string[] = []
const messageId = 'feishu-message-current'
const attachmentId = 'attachment-1'

async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}

async function contextWithPermit(userDataDir: string, localPath: string): Promise<ToolExecutionContext> {
  const attachment: RegisteredFeishuAttachment = {
    id: attachmentId,
    messageId,
    localPath,
    fileName: path.basename(localPath),
    mimeType: 'text/plain'
  }
  const fact = await probeFeishuMediaTarget(userDataDir, attachmentId, [attachment], messageId)
  if (fact.boundary !== 'inside' || fact.targetKind !== 'file' || !fact.identity || !fact.normalizedPath) {
    throw new Error('fixture must be a registered regular attachment inside feishu-media')
  }
  const input = { attachmentId }
  return {
    userDataDir,
    requestId: 'feishu-request',
    toolUseId: 'feishu-tool-use',
    remoteContext: { source: 'feishu', messageId, confirmPolicy: 'im_confirm', feishuAttachments: [attachment] },
    readExecutionPermit: buildReadExecutionPermit({
      requestId: 'feishu-request',
      toolUseId: 'feishu-tool-use',
      toolName: 'read_feishu_attachment',
      input,
      facts: [{ factId: `fact-${fact.normalizedPath}`, decisionRuleId: 'read-default-allow', normalizedPath: fact.normalizedPath, zone: 'outside-workdir', targetKind: 'file', identity: fact.identity }]
    })
  } as ToolExecutionContext
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('readFeishuAttachmentExecutor', () => {
  it('读取当前飞书消息中已登记的附件', async () => {
    const userDataDir = await tempRoot('feishu-exec-registered-')
    const mediaRoot = path.join(userDataDir, 'feishu-media')
    await fs.mkdir(mediaRoot)
    const localPath = path.join(mediaRoot, 'message.txt')
    await fs.writeFile(localPath, 'hello attachment')

    const result = await readFeishuAttachmentExecutor.execute(
      { attachmentId },
      await contextWithPermit(userDataDir, localPath)
    )
    expect(result).toMatchObject({ success: true, data: { content: 'hello attachment', fileName: 'message.txt' } })
  })

  it('消费许可解析器已校验并读取的内容，不在句柄读取后再次按路径重查', async () => {
    const userDataDir = await tempRoot('feishu-exec-bound-content-')
    const mediaRoot = path.join(userDataDir, 'feishu-media')
    await fs.mkdir(mediaRoot)
    const localPath = path.join(mediaRoot, 'message.txt')
    await fs.writeFile(localPath, 'content from validated handle')
    const ctx = await contextWithPermit(userDataDir, localPath)
    const rootRealPath = await fs.realpath(mediaRoot)
    const fileRealPath = await fs.realpath(localPath)
    const realpathSpy = vi.spyOn(fs, 'realpath')
      .mockResolvedValueOnce(rootRealPath)
      .mockResolvedValueOnce(fileRealPath)
      .mockRejectedValueOnce(new Error('path changed after the validated handle read'))

    try {
      const result = await readFeishuAttachmentExecutor.execute({ attachmentId }, ctx)

      expect(realpathSpy).toHaveBeenCalledTimes(2)
      expect(result).toMatchObject({ success: true, data: { content: 'content from validated handle' } })
    } finally {
      realpathSpy.mockRestore()
    }
  })

  it('拒绝未登记附件编号，即使模型同时提供一个媒体目录路径', async () => {
    const userDataDir = await tempRoot('feishu-exec-unregistered-')
    const mediaRoot = path.join(userDataDir, 'feishu-media')
    await fs.mkdir(mediaRoot)
    await fs.writeFile(path.join(mediaRoot, 'private.txt'), 'must not read')

    const result = await readFeishuAttachmentExecutor.execute(
      { attachmentId: 'attachment-999', relativePath: 'private.txt' },
      { userDataDir, remoteContext: { source: 'feishu', messageId, confirmPolicy: 'im_confirm', feishuAttachments: [] } } as ToolExecutionContext
    )
    expect(result).toMatchObject({ success: false, diagnostic: { caseId: 'read-attachment-not-registered' } })
    expect(JSON.stringify(result)).not.toContain('must not read')
  })

  it('确认后附件登记失效时由许可边界审计 veto，而不是 executor 提前无审计拒绝', async () => {
    const userDataDir = await tempRoot('feishu-exec-registration-veto-')
    const mediaRoot = path.join(userDataDir, 'feishu-media')
    await fs.mkdir(mediaRoot)
    const localPath = path.join(mediaRoot, 'message.txt')
    await fs.writeFile(localPath, 'must not read after deregistration')
    const events: SecurityAuditEvent[] = []
    const ctx = await contextWithPermit(userDataDir, localPath)
    ctx.audit = { record: (event) => events.push(event) }
    if (ctx.remoteContext?.source === 'feishu') ctx.remoteContext.feishuAttachments = []

    const result = await readFeishuAttachmentExecutor.execute({ attachmentId }, ctx)

    expect(result).toMatchObject({ success: false, diagnostic: { caseId: 'read-attachment-not-registered', category: 'input' } })
    expect(events).toContainEqual(expect.objectContaining({
      event: 'policy.execution-veto', requestId: 'feishu-request', toolUseId: 'feishu-tool-use',
      toolName: 'read_feishu_attachment', caseId: 'read-attachment-not-registered', failureClass: 'input',
      factId: expect.stringMatching(/^fact-[a-f0-9]{24}$/)
    }))
    expect(JSON.stringify(events)).not.toContain(localPath)
  })

  it('拒绝登记到媒体根之外的附件', async () => {
    const userDataDir = await tempRoot('feishu-exec-outside-')
    const outside = await tempRoot('feishu-exec-outside-file-')
    const mediaRoot = path.join(userDataDir, 'feishu-media')
    await fs.mkdir(mediaRoot)
    const outsidePath = path.join(outside, 'secret.txt')
    await fs.writeFile(outsidePath, 'secret')
    const attachment = { id: attachmentId, messageId, localPath: outsidePath, fileName: 'secret.txt' }
    const fact = await probeFeishuMediaTarget(userDataDir, attachmentId, [attachment], messageId)
    const badContext = {
      userDataDir,
      remoteContext: { source: 'feishu', messageId, confirmPolicy: 'im_confirm', feishuAttachments: [attachment] }
    } as ToolExecutionContext

    expect(fact.boundary).toBe('outside')
    const result = await readFeishuAttachmentExecutor.execute({ attachmentId }, badContext)
    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('目录被替换为外部链接后，登记附件读取仍被拒绝', async () => {
    const userDataDir = await tempRoot('feishu-exec-dir-race-')
    const outside = await tempRoot('feishu-exec-dir-outside-')
    const mediaRoot = path.join(userDataDir, 'feishu-media')
    const mediaParent = path.join(mediaRoot, 'cache')
    const movedParent = path.join(mediaRoot, 'cache-original')
    await fs.mkdir(mediaParent, { recursive: true })
    const localPath = path.join(mediaParent, 'message.txt')
    await fs.writeFile(localPath, 'approved attachment')
    await fs.writeFile(path.join(outside, 'message.txt'), 'secret outside')
    const ctx = await contextWithPermit(userDataDir, localPath)
    await fs.rename(mediaParent, movedParent)
    await fs.symlink(outside, mediaParent, process.platform === 'win32' ? 'junction' : 'dir')

    const result = await readFeishuAttachmentExecutor.execute({ attachmentId }, ctx)
    expect(result).toMatchObject({ success: false })
    expect(JSON.stringify(result)).not.toContain('secret outside')
  })

  it('读取前拒绝超过上限的登记附件', async () => {
    const userDataDir = await tempRoot('feishu-exec-large-')
    const mediaRoot = path.join(userDataDir, 'feishu-media')
    await fs.mkdir(mediaRoot)
    const localPath = path.join(mediaRoot, 'too-large.bin')
    await fs.writeFile(localPath, Buffer.alloc(0))
    await fs.truncate(localPath, MAX_FEISHU_ATTACHMENT_BYTES + 1)

    const result = await readFeishuAttachmentExecutor.execute(
      { attachmentId },
      await contextWithPermit(userDataDir, localPath)
    )
    expect(result).toMatchObject({ success: false, diagnostic: { caseId: 'read-target-too-large' } })
  })
})
