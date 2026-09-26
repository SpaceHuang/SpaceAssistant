import fs from 'fs/promises'
import path from 'path'
import type { FeishuInboundMessage } from '../../src/shared/feishuTypes'
import type { FeishuConfig } from '../../src/shared/feishuTypes'
import { MAX_FEISHU_ATTACHMENT_BYTES } from './feishuAttachmentRegistry'
import { shouldAcceptInbound } from './feishuInboundParser'
import type { LarkCliRunner } from './larkCliRunner'

const RESOURCE_MESSAGE_TYPES = new Set(['image', 'file', 'audio', 'video', 'media', 'post', 'merge_forward'])
const MEDIA_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function getMessages(result: unknown): Record<string, unknown>[] {
  if (!isRecord(result)) return []
  if (Array.isArray(result.messages)) return result.messages.filter(isRecord)
  const data = result.data
  if (isRecord(data) && Array.isArray(data.messages)) return data.messages.filter(isRecord)
  return []
}

function mimeTypeForResource(type: string, fileName: string): string | undefined {
  if (type === 'image') {
    const ext = path.extname(fileName).toLowerCase()
    return ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' } as Record<string, string>)[ext] ?? 'image/*'
  }
  const ext = path.extname(fileName).toLowerCase()
  return ({ '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.pdf': 'application/pdf' } as Record<string, string>)[ext]
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function pruneExpiredMessageCaches(mediaRoot: string): Promise<boolean> {
  const cacheRoot = path.join(mediaRoot, 'cache')
  await fs.mkdir(cacheRoot, { recursive: true })
  const cacheStat = await fs.lstat(cacheRoot)
  if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink()) return false
  const entries = await fs.readdir(cacheRoot, { withFileTypes: true })
  const expireBefore = Date.now() - MEDIA_CACHE_TTL_MS
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) return
    const entryPath = path.join(cacheRoot, entry.name)
    const stat = await fs.lstat(entryPath)
    if (stat.isDirectory() && !stat.isSymbolicLink() && stat.mtimeMs < expireBefore) {
      await fs.rm(entryPath, { recursive: true, force: true })
    }
  }))
  return true
}

/**
 * lark-cli event payloads contain resource keys but no local paths. Fetch this exact
 * message with the CLI's explicit resource-download option and attach only files it
 * reports under the app-managed media directory.
 */
export async function downloadInboundFeishuAttachments(
  runner: LarkCliRunner,
  message: FeishuInboundMessage,
  mediaRoot: string
): Promise<FeishuInboundMessage> {
  if (!RESOURCE_MESSAGE_TYPES.has(message.msgType ?? '')) return message
  if (!/^[A-Za-z0-9_-]+$/.test(message.messageId)) return message

  const root = path.resolve(mediaRoot)
  await fs.mkdir(root, { recursive: true })
  if (!(await pruneExpiredMessageCaches(root))) return message
  const messageRoot = path.join(root, 'cache', message.messageId)
  await fs.mkdir(messageRoot, { recursive: true })
  const [realRoot, messageStat, realMessageRoot] = await Promise.all([
    fs.realpath(root), fs.lstat(messageRoot), fs.realpath(messageRoot)
  ])
  if (!messageStat.isDirectory() || messageStat.isSymbolicLink() || !isInside(realRoot, realMessageRoot)) return message
  const result = await runner.run({
    args: [
      'im', '+messages-mget', '--message-ids', message.messageId,
      '--download-resources', '--no-reactions', '--as', 'bot', '--format', 'json'
    ],
    cwd: messageRoot,
    timeoutSec: 120
  })
  if (result.exitCode !== 0 || result.timedOut) return message

  let output: unknown
  try {
    output = JSON.parse(result.stdout) as unknown
  } catch {
    return message
  }
  const current = getMessages(output).find((item) => item.message_id === message.messageId)
  if (!current || !Array.isArray(current.resources)) return message

  const attachments = current.resources.flatMap((resource): NonNullable<FeishuInboundMessage['attachments']> => {
    if (!isRecord(resource) || resource.error === true || resource.message_id !== message.messageId) return []
    const kind = resource.type
    const localPath = resource.local_path
    if ((kind !== 'image' && kind !== 'file') || typeof localPath !== 'string' || !localPath.trim()) return []
    const absolutePath = path.resolve(messageRoot, localPath)
    if (!isInside(messageRoot, absolutePath)) return []
    const fileName = path.basename(absolutePath)
    const sizeBytes = resource.size_bytes
    if (typeof sizeBytes === 'number' && (!Number.isFinite(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_FEISHU_ATTACHMENT_BYTES)) return []
    return [{
      kind,
      localPath: absolutePath,
      fileName,
      ...(mimeTypeForResource(kind, fileName) ? { mimeType: mimeTypeForResource(kind, fileName) } : {})
    }]
  })

  return attachments.length ? { ...message, attachments: [...(message.attachments ?? []), ...attachments] } : message
}

/** Download only after the normal remote-owner checks have accepted the event. */
export async function prepareInboundFeishuAttachments(
  runner: LarkCliRunner,
  message: FeishuInboundMessage,
  mediaRoot: string,
  config: FeishuConfig,
  bindingActive = false
): Promise<FeishuInboundMessage> {
  const acceptance = shouldAcceptInbound(message, config, { bindingActive })
  if (!acceptance.accept || acceptance.reason === 'bind_window') return message
  return downloadInboundFeishuAttachments(runner, message, mediaRoot)
}
