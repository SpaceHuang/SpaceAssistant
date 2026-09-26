import path from 'path'
import type { ToolExecutor, ToolExecutorResult } from './types'
import { resolveReadPermitTarget } from '../confirmation/readPermitExecutor'
import { MAX_FEISHU_ATTACHMENT_BYTES } from '../feishu/feishuAttachmentRegistry'

const FEISHU_MEDIA_ROOT = 'feishu-media'

function mediaBoundaryFailure(caseId: string, failureClass: 'input' | 'mechanism' | 'environment' | 'integration-violation'): ToolExecutorResult {
  return {
    success: false,
    error: caseId === 'read-target-too-large'
      ? `附件超过 ${MAX_FEISHU_ATTACHMENT_BYTES / 1024 / 1024} MiB 的读取上限，未读取。`
      : caseId === 'read-attachment-not-registered'
        ? '该附件不属于当前飞书消息。'
        : '附件目标在审批后发生变化，未读取。',
    diagnostic: { caseId, category: failureClass, retryable: failureClass === 'environment' || failureClass === 'mechanism' }
  }
}

export const readFeishuAttachmentExecutor: ToolExecutor = {
  name: 'read_feishu_attachment',
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    const resolved = await resolveReadPermitTarget('read_feishu_attachment', input, ctx)
    if (!resolved.ok) return { ...mediaBoundaryFailure(resolved.caseId, resolved.failureClass), duration: Date.now() - started }

    const content = resolved.content
    const fileName = path.basename(resolved.path)
    const isText = /\.(txt|md|json|csv|log)$/i.test(fileName)
    if (isText) {
      return { success: true, data: { content: content.toString('utf8'), fileName }, duration: Date.now() - started }
    }
    return {
      success: true,
      data: { base64: content.toString('base64'), fileName, size: content.length },
      duration: Date.now() - started
    }
  }
}

export function getFeishuMediaCacheDir(userDataDir: string, messageId: string): string {
  return path.join(userDataDir, FEISHU_MEDIA_ROOT, 'cache', messageId)
}
