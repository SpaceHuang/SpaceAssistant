import type { ToolExecutor, ToolExecutionContext, ToolExecutorResult } from './types'
import { getWeChatBundle, readWeChatConfigFromDb } from '../wechat/weChatIpc'
import { executeWeChatReply, executeWeChatSend } from './weChatToolExecutor'
import { toToolUserError } from './toolUserErrors'

export const wechatReplyExecutor: ToolExecutor = {
  name: 'wechat_reply',
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    const bundle = getWeChatBundle()
    if (!bundle) return { success: false, error: '微信服务未初始化', duration: Date.now() - started }
    try {
      const text = typeof input.text === 'string' ? input.text : ''
      const r = await executeWeChatReply(
        {
          text,
          imagePath: typeof input.imagePath === 'string' ? input.imagePath : undefined,
          filePath: typeof input.filePath === 'string' ? input.filePath : undefined
        },
        {
          workDir: ctx.workDir,
          botService: bundle.botService,
          db: ctx.appDatabase!,
          sessionId: ctx.sessionId
        }
      )
      void bundle.auditLogger.append({
        type: 'reply',
        sessionId: ctx.sessionId,
        targetId: 'session',
        len: text.length,
        success: r.success
      })
      return {
        success: r.success,
        data: r.success ? { chunksSent: r.chunksSent } : undefined,
        error: r.error,
        duration: Date.now() - started
      }
    } catch (e) {
      return {
        success: false,
        error: toToolUserError(e, { toolName: 'wechat_reply' }),
        duration: Date.now() - started
      }
    }
  }
}

export const wechatSendExecutor: ToolExecutor = {
  name: 'wechat_send',
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    const bundle = getWeChatBundle()
    if (!bundle) return { success: false, error: '微信服务未初始化', duration: Date.now() - started }
    const userId = typeof input.userId === 'string' ? input.userId : ''
    const text = typeof input.text === 'string' ? input.text : ''
    if (!userId || !text) {
      return { success: false, error: '缺少 userId 或 text', duration: Date.now() - started }
    }
    if (!ctx.appDatabase) {
      return { success: false, error: '数据库未就绪', duration: Date.now() - started }
    }
    try {
      const r = await executeWeChatSend(
        {
          userId,
          text,
          imagePath: typeof input.imagePath === 'string' ? input.imagePath : undefined,
          filePath: typeof input.filePath === 'string' ? input.filePath : undefined
        },
        {
          workDir: ctx.workDir,
          botService: bundle.botService,
          getWeChatConfig: () => readWeChatConfigFromDb(ctx.appDatabase!)
        }
      )
      void bundle.auditLogger.append({
        type: 'send',
        sessionId: ctx.sessionId,
        targetId: userId,
        len: text.length,
        success: r.success
      })
      return {
        success: r.success,
        data: r.success ? { chunksSent: r.chunksSent } : undefined,
        error: r.error,
        duration: Date.now() - started
      }
    } catch (e) {
      return {
        success: false,
        error: toToolUserError(e, { toolName: 'wechat_send' }),
        duration: Date.now() - started
      }
    }
  }
}
