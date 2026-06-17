import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import type { ChatImageAttachment } from '../src/shared/domainTypes'
import {
  DEFAULT_STAGED_IMAGE_READ_MAX_BYTES,
  MAX_CHAT_IMAGE_ATTACHMENT_BYTES
} from '../src/shared/chatAttachmentLimits'
import { getFileExtension, getImageMimeType } from '../src/shared/fileTypes'
import { resolveSafePath } from './pathSecurity'

const CHAT_ATTACHMENTS_ROOT = 'chat-attachments'

/** MVP 白名单：png/jpeg/webp/gif */
const ALLOWED_CHAT_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export function chatAttachmentAbsPath(userDataDir: string, stagingKey: string): string {
  const normalized = stagingKey.replace(/\\/g, '/')
  if (!normalized.startsWith(`${CHAT_ATTACHMENTS_ROOT}/`) || normalized.includes('..')) {
    throw new Error('Invalid staging path')
  }
  const base = path.resolve(userDataDir)
  return resolveSafePath(base, stagingKey)
}

function buildStagingKey(sessionId: string, fileName: string, attachmentId: string): string {
  const ext = getFileExtension(fileName) || '.bin'
  return `${CHAT_ATTACHMENTS_ROOT}/${sessionId}/${attachmentId}${ext}`
}

function probeImageDimensions(buf: Buffer, mimeType: string): { width?: number; height?: number } {
  if (mimeType === 'image/png' && buf.length >= 24) {
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    if (width > 0 && height > 0 && width < 50_000 && height < 50_000) return { width, height }
  }
  if (mimeType === 'image/gif' && buf.length >= 10) {
    const width = buf.readUInt16LE(6)
    const height = buf.readUInt16LE(8)
    if (width > 0 && height > 0) return { width, height }
  }
  if (mimeType === 'image/jpeg' && buf.length >= 4) {
    let offset = 2
    while (offset < buf.length) {
      if (buf[offset] !== 0xff) break
      const marker = buf[offset + 1]
      if (marker === undefined) break
      if (marker === 0xc0 || marker === 0xc2) {
        if (offset + 9 <= buf.length) {
          const height = buf.readUInt16BE(offset + 5)
          const width = buf.readUInt16BE(offset + 7)
          if (width > 0 && height > 0) return { width, height }
        }
        break
      }
      const len = buf.readUInt16BE(offset + 2)
      if (len < 2) break
      offset += 2 + len
    }
  }
  return {}
}

export async function stageChatImage(args: {
  userDataDir: string
  sessionId: string
  fileName: string
  mimeType: string
  dataBase64: string
}): Promise<ChatImageAttachment | { error: string }> {
  const { userDataDir, sessionId, fileName, mimeType, dataBase64 } = args
  if (!sessionId.trim()) return { error: 'invalid_session' }
  if (!fileName.trim()) return { error: 'invalid_file_name' }
  if (!ALLOWED_CHAT_IMAGE_MIMES.has(mimeType)) return { error: 'unsupported_image' }

  const ext = getFileExtension(fileName)
  const expectedMime = getImageMimeType(ext)
  if (!expectedMime || expectedMime !== mimeType) return { error: 'unsupported_image' }

  let buf: Buffer
  try {
    buf = Buffer.from(dataBase64, 'base64')
  } catch {
    return { error: 'invalid_base64' }
  }
  if (buf.length === 0) return { error: 'empty_file' }
  if (buf.length > MAX_CHAT_IMAGE_ATTACHMENT_BYTES) return { error: 'file_too_large' }

  const attachmentId = randomUUID()
  const stagingKey = buildStagingKey(sessionId, fileName, attachmentId)
  const absPath = chatAttachmentAbsPath(userDataDir, stagingKey)
  await fs.mkdir(path.dirname(absPath), { recursive: true })
  await fs.writeFile(absPath, buf)

  const dims = probeImageDimensions(buf, mimeType)
  return {
    id: attachmentId,
    stagingKey,
    fileName,
    mimeType,
    byteLength: buf.length,
    ...dims
  }
}

export async function discardStagedImage(userDataDir: string, stagingKey: string): Promise<{ ok: true } | { error: string }> {
  try {
    const absPath = chatAttachmentAbsPath(userDataDir, stagingKey)
    await fs.unlink(absPath).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e
    })
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export async function readStagedImage(args: {
  userDataDir: string
  stagingKey: string
  maxBytes?: number
}): Promise<{ mimeType: string; dataBase64: string } | { error: string }> {
  const maxBytes = args.maxBytes ?? DEFAULT_STAGED_IMAGE_READ_MAX_BYTES
  try {
    const absPath = chatAttachmentAbsPath(args.userDataDir, args.stagingKey)
    const stat = await fs.stat(absPath)
    if (stat.size > maxBytes) return { error: 'file_too_large' }
    const buf = await fs.readFile(absPath)
    const ext = path.extname(absPath).toLowerCase()
    const mimeType = getImageMimeType(ext)
    if (!mimeType || !ALLOWED_CHAT_IMAGE_MIMES.has(mimeType)) return { error: 'unsupported_image' }
    return { mimeType, dataBase64: buf.toString('base64') }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export async function resolveChatAttachmentBase64(
  userDataDir: string,
  stagingKey: string
): Promise<{ mimeType: string; data: string } | null> {
  const result = await readStagedImage({
    userDataDir,
    stagingKey,
    maxBytes: MAX_CHAT_IMAGE_ATTACHMENT_BYTES
  })
  if ('error' in result) return null
  return { mimeType: result.mimeType, data: result.dataBase64 }
}

export async function deleteSessionChatAttachments(userDataDir: string, sessionId: string): Promise<void> {
  const dir = path.join(userDataDir, CHAT_ATTACHMENTS_ROOT, sessionId)
  await fs.rm(dir, { recursive: true, force: true })
}
