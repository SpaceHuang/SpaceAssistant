import fs from 'fs/promises'
import path from 'path'
import type { IncomingMessage } from '@wechatbot/wechatbot'
import type { SessionQueries } from '../sessionStorage/contracts'
import { resolveSafeWorkDirPath } from '../pathSecurity'
import type { WeChatBotService } from '../wechat/weChatBotService'
import type { WeChatConfig } from '../../src/shared/wechatTypes'

export class WeChatOutboundExecutionUncertainError extends Error {
  constructor(readonly operation: 'send' | 'reply') {
    super(`微信${operation === 'send' ? '发送' : '回复'}请求已发出，但未收到可确认结果`)
    this.name = 'WeChatOutboundExecutionUncertainError'
  }
}
import { formatWeChatSummary } from '../wechat/weChatReplyService'
import { getWeChatBundle } from '../wechat/weChatIpc'

const IMAGE_MAX = 10 * 1024 * 1024
const FILE_MAX = 25 * 1024 * 1024
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

async function readMedia(
  workDir: string,
  imagePath?: string,
  filePath?: string
): Promise<{
  buffer?: Buffer
  fileName?: string
  error?: string
  diagnostic?: { caseId: string; retryable: boolean; category: 'mechanism' }
}> {
  const rel = imagePath ?? filePath
  if (!rel) return {}
  try {
    const abs = await resolveSafeWorkDirPath(workDir, rel)
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
      return {
        error: '文件路径不在工作目录范围内',
        diagnostic: { caseId: 'wechat-media-target-outside-workdir', retryable: false, category: 'mechanism' }
      }
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
    signal?: AbortSignal
  }
): Promise<{ success: boolean; chunksSent?: number; error?: string; diagnostic?: { caseId: string; retryable: boolean; category: 'mechanism' } }> {
  const cfg = ctx.getWeChatConfig()
  if (!cfg.enabled || !cfg.loggedIn) {
    return { success: false, error: '微信未绑定，请先在设置页完成绑定' }
  }
  const bot = ctx.botService.getRawBot()
  if (!bot) return { success: false, error: '微信 Bot 未就绪' }

  const media = await readMedia(ctx.workDir, input.imagePath, input.filePath)
  if (media.error) return { success: false, error: media.error, ...(media.diagnostic ? { diagnostic: media.diagnostic } : {}) }
  if (ctx.signal?.aborted) return { success: false, error: '微信发送已取消' }

  const text = formatWeChatSummary(input.text)
  try {
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
  } catch {
    throw new WeChatOutboundExecutionUncertainError('send')
  }
  return { success: true, chunksSent: Math.max(1, Math.ceil(text.length / 2000)) }
}

export async function executeWeChatReply(
  input: { text: string; imagePath?: string; filePath?: string },
  ctx: {
    workDir: string
    botService: WeChatBotService
    sessionQueries: SessionQueries
    sessionId?: string
    expectedMessageId?: string
    signal?: AbortSignal
  }
): Promise<{ success: boolean; chunksSent?: number; error?: string; diagnostic?: { caseId: string; retryable: boolean; category: 'mechanism' } }> {
  const bot = ctx.botService.getRawBot()
  if (!bot) return { success: false, error: '微信 Bot 未就绪' }

  let inboundRaw: IncomingMessage | undefined
  if (ctx.sessionId) {
    inboundRaw = getWeChatBundle()?.router?.getInboundForSession(ctx.sessionId)
    if (!inboundRaw) {
      const session = ctx.sessionQueries.readSession(ctx.sessionId)
      const meta = session?.metadata as { source?: string } | undefined
      if (meta?.source !== 'wechat') {
        return { success: false, error: '当前会话无有效微信上下文，无法回复' }
      }
      return { success: false, error: '微信入站上下文已过期，请重新发送指令' }
    }
  } else {
    return { success: false, error: '缺少会话上下文' }
  }

  const currentMessageId = inboundRaw.raw.client_id || `${inboundRaw.userId}-${inboundRaw.timestamp.getTime()}`
  if (ctx.expectedMessageId && currentMessageId !== ctx.expectedMessageId) {
    return { success: false, error: '微信入站消息已变化，请重新授权回复' }
  }

  const media = await readMedia(ctx.workDir, input.imagePath, input.filePath)
  if (media.error) return { success: false, error: media.error, ...(media.diagnostic ? { diagnostic: media.diagnostic } : {}) }
  if (ctx.signal?.aborted) return { success: false, error: '微信回复已取消' }

  const text = formatWeChatSummary(input.text)
  try {
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
  } catch {
    throw new WeChatOutboundExecutionUncertainError('reply')
  }
  return { success: true, chunksSent: Math.max(1, Math.ceil(text.length / 2000)) }
}
