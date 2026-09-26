import fs from 'fs/promises'
import path from 'path'
import type { RegisteredFeishuAttachment } from '../../feishu/feishuAttachmentRegistry'

export type FeishuMediaBoundary = 'inside' | 'outside' | 'unknown'
export type FeishuMediaTargetFact = {
  boundary: FeishuMediaBoundary
  attachmentId?: string
  normalizedPath?: string
  targetKind?: 'file' | 'directory' | 'missing' | 'special' | 'unknown'
  identity?: { dev: number; ino: number; mode: number; size: number; mtimeMs: number }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** 只接受当前入站消息已登记的附件 ID；模型不能选择媒体目录中的其他文件。 */
export async function probeFeishuMediaTarget(
  userDataDir: string,
  attachmentId: unknown,
  attachments: readonly RegisteredFeishuAttachment[] | undefined,
  messageId: string
): Promise<FeishuMediaTargetFact> {
  const attachment = typeof attachmentId === 'string'
    ? attachments?.find((entry) => entry.id === attachmentId && entry.messageId === messageId)
    : undefined
  if (!attachment) return { boundary: 'outside', attachmentId: typeof attachmentId === 'string' ? attachmentId : undefined }

  try {
    const lexicalRoot = path.resolve(userDataDir, 'feishu-media')
    const rootEntry = await fs.lstat(lexicalRoot)
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) return { boundary: 'unknown', attachmentId: attachment.id }
    const root = await fs.realpath(lexicalRoot)
    const candidate = path.resolve(attachment.localPath)
    if (!isInside(lexicalRoot, candidate)) return { boundary: 'outside', attachmentId: attachment.id }

    const relative = path.relative(lexicalRoot, candidate)
    let cursor = lexicalRoot
    for (const segment of relative.split(path.sep)) {
      cursor = path.join(cursor, segment)
      const component = await fs.lstat(cursor)
      if (component.isSymbolicLink()) return { boundary: 'unknown', attachmentId: attachment.id }
    }

    const normalizedPath = await fs.realpath(candidate)
    if (!isInside(root, normalizedPath)) return { boundary: 'outside', attachmentId: attachment.id }
    const stat = await fs.stat(normalizedPath)
    if (!stat.isFile()) return { boundary: 'unknown', attachmentId: attachment.id, normalizedPath, targetKind: stat.isDirectory() ? 'directory' : 'unknown' }
    return {
      boundary: 'inside',
      attachmentId: attachment.id,
      normalizedPath,
      targetKind: 'file',
      identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs }
    }
  } catch {
    return { boundary: 'unknown', attachmentId: attachment.id }
  }
}

export async function classifyFeishuMediaTarget(
  userDataDir: string,
  attachmentId: unknown,
  attachments: readonly RegisteredFeishuAttachment[] | undefined,
  messageId: string
): Promise<FeishuMediaBoundary> {
  return (await probeFeishuMediaTarget(userDataDir, attachmentId, attachments, messageId)).boundary
}
