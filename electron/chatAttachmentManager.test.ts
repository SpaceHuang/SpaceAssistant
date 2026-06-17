import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chatAttachmentAbsPath,
  discardStagedImage,
  readStagedImage,
  resolveChatAttachmentBase64,
  stageChatImage
} from './chatAttachmentManager'
import { MAX_CHAT_IMAGE_ATTACHMENT_BYTES } from '../src/shared/chatAttachmentLimits'

/** 1x1 PNG */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('chatAttachmentManager', () => {
  let tmpUserData: string
  const sessionId = 'sess-test-1'

  beforeEach(async () => {
    tmpUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-chat-attach-'))
  })

  afterEach(async () => {
    await fs.rm(tmpUserData, { recursive: true, force: true })
  })

  it('stages image and reads back', async () => {
    const staged = await stageChatImage({
      userDataDir: tmpUserData,
      sessionId,
      fileName: 'photo.png',
      mimeType: 'image/png',
      dataBase64: TINY_PNG_BASE64
    })
    expect('error' in staged).toBe(false)
    if ('error' in staged) return

    expect(staged.fileName).toBe('photo.png')
    expect(staged.mimeType).toBe('image/png')
    expect(staged.byteLength).toBeGreaterThan(0)
    expect(staged.width).toBe(1)
    expect(staged.height).toBe(1)

    const read = await readStagedImage({ userDataDir: tmpUserData, stagingKey: staged.stagingKey })
    expect('error' in read).toBe(false)
    if ('error' in read) return
    expect(read.mimeType).toBe('image/png')
    expect(read.dataBase64).toBe(TINY_PNG_BASE64)
  })

  it('rejects oversized files', async () => {
    const big = Buffer.alloc(MAX_CHAT_IMAGE_ATTACHMENT_BYTES + 1).toString('base64')
    const result = await stageChatImage({
      userDataDir: tmpUserData,
      sessionId,
      fileName: 'big.png',
      mimeType: 'image/png',
      dataBase64: big
    })
    expect(result).toEqual({ error: 'file_too_large' })
  })

  it('rejects unsupported mime', async () => {
    const result = await stageChatImage({
      userDataDir: tmpUserData,
      sessionId,
      fileName: 'doc.pdf',
      mimeType: 'application/pdf',
      dataBase64: TINY_PNG_BASE64
    })
    expect(result).toEqual({ error: 'unsupported_image' })
  })

  it('rejects path traversal in stagingKey on read', async () => {
    const result = await readStagedImage({
      userDataDir: tmpUserData,
      stagingKey: '../secrets.txt'
    })
    expect('error' in result).toBe(true)
  })

  it('discards staged file', async () => {
    const staged = await stageChatImage({
      userDataDir: tmpUserData,
      sessionId,
      fileName: 'x.png',
      mimeType: 'image/png',
      dataBase64: TINY_PNG_BASE64
    })
    if ('error' in staged) throw new Error(staged.error)

    const discard = await discardStagedImage(tmpUserData, staged.stagingKey)
    expect(discard).toEqual({ ok: true })

    const abs = chatAttachmentAbsPath(tmpUserData, staged.stagingKey)
    await expect(fs.access(abs)).rejects.toThrow()
  })

  it('resolveChatAttachmentBase64 returns null for missing file', async () => {
    const resolved = await resolveChatAttachmentBase64(tmpUserData, 'chat-attachments/s1/missing.png')
    expect(resolved).toBeNull()
  })

  it('readStagedImage respects maxBytes', async () => {
    const staged = await stageChatImage({
      userDataDir: tmpUserData,
      sessionId,
      fileName: 'x.png',
      mimeType: 'image/png',
      dataBase64: TINY_PNG_BASE64
    })
    if ('error' in staged) throw new Error(staged.error)

    const read = await readStagedImage({
      userDataDir: tmpUserData,
      stagingKey: staged.stagingKey,
      maxBytes: 10
    })
    expect('error' in read).toBe(true)
    if ('error' in read) expect(read.error).toBe('file_too_large')
  })
})
