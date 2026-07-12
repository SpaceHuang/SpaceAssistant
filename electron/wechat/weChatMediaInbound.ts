import fs from 'fs/promises'
import path from 'path'
import type { IncomingMessage, WeChatBot } from '@wechatbot/wechatbot'
import type { WeChatInboundMessage } from '../../src/shared/wechatTypes'

export type WeChatMediaDownloadResult = {
  localPath: string
  relativePath: string
  fileName: string
  mimeType?: string
}

const INBOUND_SUBDIR = '.wechat-inbound'

export async function ensureWeChatInboundDir(workDir: string): Promise<string> {
  const dir = path.join(workDir, INBOUND_SUBDIR)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

export async function downloadWeChatInboundMedia(
  bot: WeChatBot,
  raw: IncomingMessage,
  workDir: string
): Promise<WeChatMediaDownloadResult | null> {
  try {
    const downloaded = await bot.download(raw)
    if (!downloaded?.data?.length) return null
    const inboundDir = await ensureWeChatInboundDir(workDir)
    const ext = guessExtension(raw.type, downloaded.fileName)
    const fileName = downloaded.fileName?.trim() || `${raw.raw.client_id || Date.now()}${ext}`
    const safeName = fileName.replace(/[<>:"/\\|?*]/g, '_')
    const localPath = path.join(inboundDir, safeName)
    await fs.writeFile(localPath, downloaded.data)
    return {
      localPath,
      relativePath: path.join(INBOUND_SUBDIR, safeName).replace(/\\/g, '/'),
      fileName: safeName,
      mimeType: downloaded.type
    }
  } catch {
    return null
  }
}

function guessExtension(type: string, fileName?: string): string {
  if (fileName?.includes('.')) return path.extname(fileName)
  if (type === 'image') return '.jpg'
  if (type === 'file') return '.bin'
  if (type === 'voice') return '.amr'
  if (type === 'video') return '.mp4'
  return '.bin'
}

export function buildMediaUserMessage(
  msg: WeChatInboundMessage,
  media: WeChatMediaDownloadResult
): string {
  const caption = msg.text.trim()
  const prefix =
    msg.type === 'image'
      ? `[微信图片已保存: ${media.relativePath}]`
      : `[微信文件已保存: ${media.relativePath}]`
  return caption ? `${prefix}\n${caption}` : prefix
}
