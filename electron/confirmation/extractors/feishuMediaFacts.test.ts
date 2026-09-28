import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { classifyFeishuMediaTarget, probeFeishuMediaTarget } from './feishuMediaFacts'
import type { RegisteredFeishuAttachment } from '../../feishu/feishuAttachmentRegistry'
import { canCreateSymlinks } from '../../../src/test/symlinkCapability'

const roots: string[] = []
const messageId = 'message-current'
const attachmentId = 'attachment-1'
async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}
function registration(localPath: string, overrides: Partial<RegisteredFeishuAttachment> = {}): RegisteredFeishuAttachment {
  return { id: attachmentId, messageId, localPath, fileName: path.basename(localPath), ...overrides }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('classifyFeishuMediaTarget', () => {
  it('只允许当前消息已登记且位于媒体目录内的附件', async () => {
    const userData = await tempRoot('feishu-facts-')
    const mediaRoot = path.join(userData, 'feishu-media')
    await fs.mkdir(mediaRoot)
    const filePath = path.join(mediaRoot, 'message.txt')
    await fs.writeFile(filePath, 'inside')
    const entries = [registration(filePath)]

    expect(await classifyFeishuMediaTarget(userData, attachmentId, entries, messageId)).toBe('inside')
    expect(await classifyFeishuMediaTarget(userData, 'message.txt', entries, messageId)).toBe('outside')
    expect(await classifyFeishuMediaTarget(userData, attachmentId, entries, 'another-message')).toBe('outside')
  })

  it('拒绝指向媒体目录外的已登记路径', async () => {
    const userData = await tempRoot('feishu-facts-outside-')
    const outside = await tempRoot('feishu-facts-target-')
    await fs.mkdir(path.join(userData, 'feishu-media'))
    const filePath = path.join(outside, 'secret.txt')
    await fs.writeFile(filePath, 'secret')
    const fact = await probeFeishuMediaTarget(userData, attachmentId, [registration(filePath)], messageId)
    expect(fact.boundary).toBe('outside')
    expect(fact.identity).toBeUndefined()
  })

  // 依赖真实 symlink 的用例以能力探测保护：win32 非特权进程 fs.symlink 直接 EPERM；安全语义由下方 mock 通路覆盖。
  it.skipIf(!canCreateSymlinks())('拒绝附件路径中的符号链接', async () => {
    const userData = await tempRoot('feishu-facts-link-')
    const outside = await tempRoot('feishu-facts-link-target-')
    const mediaRoot = path.join(userData, 'feishu-media')
    await fs.mkdir(mediaRoot)
    const target = path.join(outside, 'secret.txt')
    const link = path.join(mediaRoot, 'escape.txt')
    await fs.writeFile(target, 'secret')
    await fs.symlink(target, link)
    expect(await classifyFeishuMediaTarget(userData, attachmentId, [registration(link)], messageId)).toBe('unknown')
  })

  it.skipIf(!canCreateSymlinks())('媒体根目录缺失或被替换成符号链接时返回 unknown', async () => {
    const userData = await tempRoot('feishu-facts-root-')
    const outside = await tempRoot('feishu-facts-root-target-')
    expect(await classifyFeishuMediaTarget(userData, attachmentId, [registration(path.join(userData, 'feishu-media', 'a.txt'))], messageId)).toBe('unknown')
    await fs.symlink(outside, path.join(userData, 'feishu-media'))
    expect(await classifyFeishuMediaTarget(userData, attachmentId, [registration(path.join(userData, 'feishu-media', 'a.txt'))], messageId)).toBe('unknown')
  })

  it('目录被换成外部链接后，已登记的原始附件路径不会返回外部事实', async () => {
    const userData = await tempRoot('feishu-facts-dir-swap-')
    const outside = await tempRoot('feishu-facts-dir-swap-outside-')
    const mediaRoot = path.join(userData, 'feishu-media')
    const parent = path.join(mediaRoot, 'cache')
    const moved = path.join(mediaRoot, 'cache-original')
    await fs.mkdir(parent, { recursive: true })
    const filePath = path.join(parent, 'message.txt')
    await fs.writeFile(filePath, 'inside')
    await fs.writeFile(path.join(outside, 'message.txt'), 'outside')
    const entry = registration(filePath)
    await fs.rename(parent, moved)
    await fs.symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir')

    const fact = await probeFeishuMediaTarget(userData, attachmentId, [entry], messageId)
    expect(fact.boundary).not.toBe('inside')
    expect(fact.identity).toBeUndefined()
  })

  it('mock 通路：媒体目录内组件 lstat 报 symlink 时返回 unknown（win32 无特权平台的安全语义锚）', async () => {
    const userData = await tempRoot('feishu-facts-mock-link-')
    const mediaRoot = path.join(userData, 'feishu-media')
    await fs.mkdir(mediaRoot)
    const escape = path.join(mediaRoot, 'escape.txt')
    await fs.writeFile(escape, 'secret')
    const originalLstat = fs.lstat.bind(fs)
    const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (target, ...args) => {
      if (String(target) === escape) {
        const real = await originalLstat(target, ...args)
        return {
          isSymbolicLink: () => true,
          isFile: () => false,
          isDirectory: () => false,
          dev: real.dev, ino: real.ino, mode: real.mode, size: real.size, mtimeMs: real.mtimeMs
        } as never
      }
      return originalLstat(target, ...args)
    })
    try {
      expect(await classifyFeishuMediaTarget(userData, attachmentId, [registration(escape)], messageId)).toBe('unknown')
    } finally {
      lstatSpy.mockRestore()
    }
  })
})
