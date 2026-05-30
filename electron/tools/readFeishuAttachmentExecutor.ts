import fs from 'fs/promises'
import path from 'path'
import type { ToolExecutor, ToolExecutorResult } from './types'
import { toToolUserError } from './toolUserErrors'

const FEISHU_MEDIA_ROOT = 'feishu-media'

export const readFeishuAttachmentExecutor: ToolExecutor = {
  name: 'read_feishu_attachment',
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    const rel = typeof input.relativePath === 'string' ? input.relativePath.trim() : ''
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
      return { success: false, error: '无效的 relativePath', duration: Date.now() - started }
    }
    const root = path.join(ctx.userDataDir, FEISHU_MEDIA_ROOT)
    const abs = path.resolve(root, rel)
    if (!abs.startsWith(root + path.sep) && abs !== root) {
      return { success: false, error: '路径超出 feishu-media 范围', duration: Date.now() - started }
    }
    try {
      const content = await fs.readFile(abs)
      const isText = /\.(txt|md|json|csv|log)$/i.test(rel)
      if (isText) {
        return { success: true, data: { content: content.toString('utf8'), path: abs }, duration: Date.now() - started }
      }
      return {
        success: true,
        data: { base64: content.toString('base64'), path: abs, size: content.length },
        duration: Date.now() - started
      }
    } catch (e) {
      return {
        success: false,
        error: toToolUserError(e, { toolName: 'read_feishu_attachment' }),
        duration: Date.now() - started
      }
    }
  }
}

export function getFeishuMediaCacheDir(userDataDir: string, messageId: string): string {
  return path.join(userDataDir, FEISHU_MEDIA_ROOT, 'cache', messageId)
}
