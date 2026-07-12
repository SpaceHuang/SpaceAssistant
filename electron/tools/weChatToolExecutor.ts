import fs from 'fs/promises'
import path from 'path'
import type { IncomingMessage } from '@wechatbot/wechatbot'
import type { AppDatabase } from '../database'
import { listSessions } from '../database'
import { resolveSafePath } from '../pathSecurity'
import type { WeChatBotService } from '../wechat/weChatBotService'
import type { WeChatConfig } from '../../src/shared/wechatTypes'
import { formatWeChatSummary } from '../wechat/weChatReplyService'
import { getWeChatBundle } from '../wechat/weChatIpc'

const IMAGE_MAX = 10 * 1024 * 1024
const FILE_MAX = 25 * 1024 * 1024
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

async function readMedia(
  workDir: string,
  imagePath?: string,
  filePath?: string
): Promise<{ buffer?: Buffer; fileName?: string; error?: string }> {
  const rel = imagePath ?? filePath
  if (!rel) return {}
  try {
    const abs = resolveSafePath(workDir, rel)
    const stat = await fs.stat(abs)
    const ext = path.extname(abs).toLowerCase()
    const isImage = imagePath != null || IMAGE_EXT.has(ext)
    const max = isImage ? IMAGE_MAX : FILE_MAX
    if (stat.size > max) {
      return { error: `文件大小超过限制（最大 ${Math.round(max / 1024 / 1024)}MB）` }
    }
    const buffer = await fs.readFile(abs)
    return { buffer, fileName: path.basename(abs) }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('工作目录') || msg.includes('workDir')) {
      return { error: '文件路径不在工作目录范围内' }
    }
    return { error: '文件不存在，请检查路径' }
  }
}

export async function executeWeChatSend(
  input: { userId: string; text: string; imagePath?: string; filePath?: string },
  ctx: {
    workDir: string
    botService: WeChatBotService
    getWeChatConfig: () => WeChatConfig
  }
): Promise<{ success: boolean; chunksSent?: number; error?: string }> {
  const cfg = ctx.getWeChatConfig()
  if (!cfg.enabled || !cfg.loggedIn) {
    return { success: false, error: '微信未绑定，请先在设置页完成绑定' }
  }
  const bot = ctx.botService.getRawBot()
  if (!bot) return { success: false, error: '微信 Bot 未就绪' }

  const media = await readMedia(ctx.workDir, input.imagePath, input.filePath)
  if (media.error) return { success: false, error: media.error }

  try {
    const text = formatWeChatSummary(input.text)
    if (media.buffer && media.fileName) {
      const ext = path.extname(media.fileName).toLowerCase()
      if (IMAGE_EXT.has(ext)) {
        await bot.send(input.userId, { image: media.buffer, caption: text })
      } else {
        await bot.send(input.userId, { file: media.buffer, fileName: media.fileName, caption: text })
      }
    } else {
      await bot.send(input.userId, text)
    }
    return { success: true, chunksSent: Math.max(1, Math.ceil(text.length / 2000)) }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { success: false, error: msg.includes('timeout') ? '发送超时，请重试' : `网络连接失败，请检查网络后重试：${msg}` }
  }
}

export async function executeWeChatReply(
  input: { text: string; imagePath?: string; filePath?: string },
  ctx: {
    workDir: string
    botService: WeChatBotService
    db: AppDatabase
    sessionId?: string
  }
): Promise<{ success: boolean; chunksSent?: number; error?: string }> {
  const bot = ctx.botService.getRawBot()
  if (!bot) return { success: false, error: '微信 Bot 未就绪' }

  let inboundRaw: IncomingMessage | undefined
  if (ctx.sessionId) {
    inboundRaw = getWeChatBundle()?.router?.getInboundForSession(ctx.sessionId)
    if (!inboundRaw) {
      const session = listSessions(ctx.db).find((s) => s.id === ctx.sessionId)
      const meta = session?.metadata as { source?: string } | undefined
      if (meta?.source !== 'wechat') {
        return { success: false, error: '当前会话无有效微信上下文，无法回复' }
      }
      return { success: false, error: '微信入站上下文已过期，请重新发送指令' }
    }
  } else {
    return { success: false, error: '缺少会话上下文' }
  }

  const media = await readMedia(ctx.workDir, input.imagePath, input.filePath)
  if (media.error) return { success: false, error: media.error }

  try {
    const text = formatWeChatSummary(input.text)
    if (media.buffer && media.fileName) {
      const ext = path.extname(media.fileName).toLowerCase()
      if (IMAGE_EXT.has(ext)) {
        await bot.reply(inboundRaw, { image: media.buffer, caption: text })
      } else {
        await bot.reply(inboundRaw, { file: media.buffer, fileName: media.fileName, caption: text })
      }
    } else {
      await bot.reply(inboundRaw, text)
    }
    return { success: true, chunksSent: Math.max(1, Math.ceil(text.length / 2000)) }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { success: false, error: msg }
  }
}
