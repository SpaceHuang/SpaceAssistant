import fs from 'fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'path'
import type { IncomingMessage } from '@wechatbot/wechatbot'
import type { SessionQueries } from '../sessionStorage/public/ports'
import { resolveSafeWorkDirPath } from '../pathSecurity'
import { verifyDeferredWeChatAttachment } from './weChatAttachmentBinding'
import type { WeChatBotService } from '../wechat/weChatBotService'
import type { WeChatConfig } from '../../src/shared/wechatTypes'
import { createHash } from 'node:crypto'
import { createImAttachmentFacts } from '../../src/shared/confirmation/imAttachmentFacts'
import { assessImOutboundContent, assertImOutboundAllowed, type ImOutboundFacts } from '../../src/shared/confirmation/outboundClassification'

export class WeChatOutboundExecutionUncertainError extends Error {
  constructor(readonly operation: 'send' | 'reply') {
    super(`微信${operation === 'send' ? '发送' : '回复'}请求已发出，但未收到可确认结果`)
    this.name = 'WeChatOutboundExecutionUncertainError'
  }
}
import { formatWeChatSummary } from '../wechat/weChatReplyService'
import { getWeChatBundle } from '../wechat/weChatIpc'

const IMAGE_MAX = 10 * 1024 * 1024
// Keep the current WeChat SDK/channel transport ceiling. Approval can bind larger files,
// but dispatch still fails clearly until the channel's upload capability supports them.
const FILE_MAX = 25 * 1024 * 1024
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
export { verifyDeferredWeChatAttachment } from './weChatAttachmentBinding'

async function readMedia(
  workDir: string,
  imagePath?: string,
  filePath?: string,
  externalApproval?: Readonly<{ path: string; sha256: string }>
): Promise<{
  buffer?: Buffer
  fileName?: string
  contentVersion?: string
  resolvedPath?: string
  error?: string
  diagnostic?: { caseId: string; retryable: boolean; category: 'mechanism' }
}> {
  const rel = imagePath ?? filePath
  if (!rel) return {}
  try {
    let abs: string
    if (externalApproval && path.isAbsolute(rel)) {
      const real = await fs.realpath(rel)
      if (real !== externalApproval.path) throw new Error('external attachment path changed')
      const link = await fs.lstat(rel)
      if (!link.isFile() || link.isSymbolicLink()) throw new Error('external attachment is not a regular file')
      abs = real
    } else {
      abs = await resolveSafeWorkDirPath(workDir, rel)
    }
    const stat = await fs.stat(abs)
    const ext = path.extname(abs).toLowerCase()
    const isImage = imagePath != null || IMAGE_EXT.has(ext)
    const max = isImage ? IMAGE_MAX : FILE_MAX
    if (stat.size > max) {
      return { error: `文件大小超过限制（最大 ${Math.round(max / 1024 / 1024)}MB）` }
    }
    let buffer: Buffer
    if (externalApproval) {
      const handle = await fs.open(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      try {
        const opened = await handle.stat()
        if (!opened.isFile()) throw new Error('external attachment is not a regular file')
        buffer = await handle.readFile()
        const after = await handle.stat()
        const digest = createHash('sha256').update(buffer).digest('hex')
        if (opened.dev !== after.dev || opened.ino !== after.ino || opened.mode !== after.mode || opened.size !== after.size ||
          opened.mtimeMs !== after.mtimeMs || buffer.byteLength !== after.size || digest !== externalApproval.sha256) {
          throw new Error('external attachment approval changed')
        }
      } finally { await handle.close() }
    } else {
      buffer = await fs.readFile(abs)
    }
    return { buffer, fileName: path.basename(abs), contentVersion: createHash('sha256').update(buffer).digest('hex'), resolvedPath: abs }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('external attachment')) {
      return { error: '附件审批材料已变化', diagnostic: { caseId: 'wechat-media-approved-material-changed', retryable: false, category: 'mechanism' } }
    }
    if (msg.includes('工作目录') || msg.includes('workDir')) {
      return {
        error: '文件路径不在工作目录范围内',
        diagnostic: { caseId: 'wechat-media-target-outside-workdir', retryable: false, category: 'mechanism' }
      }
    }
    return { error: '文件不存在，请检查路径' }
  }
}

async function attachmentHasSensitiveMaterial(media: Awaited<ReturnType<typeof readMedia>>, workDir: string): Promise<boolean> {
  if (!media.buffer || !media.fileName || !media.resolvedPath) return false
  let relativePath: string
  try { relativePath = path.relative(await fs.realpath(workDir), media.resolvedPath) }
  // A path binding failure is a mechanism error, so the compatibility adapter remains fail-closed
  // without manufacturing a sensitive-content observation.
  catch { return true }
  const facts = await createImAttachmentFacts({
    fileName: media.fileName,
    relativePath,
    content: media.buffer.toString('utf8'),
    contentDigest: media.contentVersion ?? createHash('sha256').update(media.buffer).digest('hex'),
    inspectionCoverage: 'complete'
  })
  // P1 compatibility period: the legacy attachment authorization consumer maps the observed
  // evidence to its prior behavior. Phase 2 moves the policy action to explicit rules.
  return facts.evidenceKinds.length > 0
}

/** Host inspection for the prepared reply path; binary and non-reviewable attachments stay unapproved. */
export async function inspectWeChatTaskReplyAttachment(workDir: string, imagePath?: string, filePath?: string): Promise<Pick<ImOutboundFacts,
  'attachmentAuthorized' | 'attachmentApprovalRequired' | 'attachmentPath' | 'checkedAttachmentPath' | 'attachmentContentVersion' | 'checkedAttachmentContentVersion' | 'externalAttachmentReview'>> {
  const requestedPath = imagePath ?? filePath
  let media = await readMedia(workDir, imagePath, filePath)
  let external = false
  if (requestedPath && !media.buffer && path.isAbsolute(requestedPath) && !imagePath) {
    try {
      const resolved = await fs.realpath(requestedPath)
      const link = await fs.lstat(requestedPath)
      if (!link.isFile() || link.isSymbolicLink()) return deniedAttachment(requestedPath)
      const extension = path.extname(resolved).toLowerCase()
      const image = IMAGE_EXT.has(extension)
      const reviewableText = ['.txt', '.md'].includes(extension)
      const humanReviewBinary = image || extension === '.pdf'
      if (!reviewableText && !humanReviewBinary) return deniedAttachment(requestedPath)
      const maxBytes = reviewableText ? 20_000 : image ? IMAGE_MAX : FILE_MAX
      const handle = await fs.open(resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      try {
        const before = await handle.stat()
        if (!before.isFile() || before.size > maxBytes) return deniedAttachment(requestedPath)
        // Read at most the review limit plus one byte; this also bounds memory if the file grows.
        const buffer = Buffer.alloc(Math.min(maxBytes + 1, before.size + 1))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        if (bytesRead > maxBytes) return deniedAttachment(requestedPath)
        const after = await handle.stat()
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytesRead !== after.size) {
          return deniedAttachment(requestedPath)
        }
        const bytes = buffer.subarray(0, bytesRead)
        media = { buffer: bytes, fileName: path.basename(resolved), contentVersion: createHash('sha256').update(bytes).digest('hex'), resolvedPath: resolved }
        external = true
      } finally { await handle.close() }
    } catch { /* Outside targets without a complete regular-file observation remain unreviewable. */ }
  }
  const denied = { attachmentAuthorized: false, ...(requestedPath ? { attachmentPath: requestedPath } : {}) }
  if (!requestedPath || media.error || !media.buffer || !media.fileName || !media.resolvedPath || !media.contentVersion) return denied
  const extension = path.extname(media.fileName).toLowerCase()
  const reviewableText = ['.txt', '.md'].includes(extension) && media.buffer.length <= 20_000
  const humanReviewBinary = IMAGE_EXT.has(extension) || extension === '.pdf'
  if (!reviewableText && !humanReviewBinary) return denied
  if (humanReviewBinary) {
    if (await attachmentHasSensitiveMaterial(media, workDir)) return denied
    // The immutable bytes are measured now, but binary media is never auto-authorized.
    // The registered tool promotes this exact binding only after a concrete user receipt.
    return { attachmentAuthorized: false, attachmentApprovalRequired: true,
      attachmentPath: media.resolvedPath, checkedAttachmentPath: media.resolvedPath,
      attachmentContentVersion: media.contentVersion, checkedAttachmentContentVersion: media.contentVersion }
  }
  let content: string
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(media.buffer) }
  catch { return denied }
  const sensitive = external
    ? (await createImAttachmentFacts({ fileName: media.fileName, relativePath: media.fileName, content,
      contentDigest: media.contentVersion, inspectionCoverage: 'complete' })).evidenceKinds.length > 0
    : await attachmentHasSensitiveMaterial(media, workDir)
  const classification = assessImOutboundContent(content)
  if (sensitive || classification !== 'ordinary') return denied
  if (external) return { attachmentAuthorized: false, attachmentApprovalRequired: true,
    attachmentPath: media.resolvedPath, checkedAttachmentPath: media.resolvedPath,
    attachmentContentVersion: media.contentVersion, checkedAttachmentContentVersion: media.contentVersion,
    externalAttachmentReview: { path: media.resolvedPath!, sha256: media.contentVersion!, answerer: 'agent' } }
  return { attachmentAuthorized: true, attachmentPath: media.resolvedPath, checkedAttachmentPath: media.resolvedPath,
    attachmentContentVersion: media.contentVersion, checkedAttachmentContentVersion: media.contentVersion }
}

function deniedAttachment(requestedPath: string) {
  return { attachmentAuthorized: false, attachmentPath: requestedPath } as const
}

export async function executeWeChatSend(
  input: { userId: string; text: string; imagePath?: string; filePath?: string },
  ctx: {
    workDir: string
    botService: WeChatBotService
    getWeChatConfig: () => WeChatConfig
    signal?: AbortSignal
    outboundDeliveryFacts?: ImOutboundFacts
    sessionId?: string
  }
): Promise<{ success: boolean; chunksSent?: number; error?: string; diagnostic?: { caseId: string; retryable: boolean; category: 'mechanism' } }> {
  const cfg = ctx.getWeChatConfig()
  if (!cfg.enabled || !cfg.loggedIn) {
    return { success: false, error: '微信未绑定，请先在设置页完成绑定' }
  }
  const bot = ctx.botService.getRawBot()
  if (!bot) return { success: false, error: '微信 Bot 未就绪' }

  // Active-send retains its explicit deny; external attachment approval exists only for a bound task reply.
  const media = await readMedia(ctx.workDir, input.imagePath, input.filePath)
  if (media.error) return { success: false, error: media.error, ...(media.diagnostic ? { diagnostic: media.diagnostic } : {}) }
  if (ctx.signal?.aborted) return { success: false, error: '微信发送已取消' }

  const text = formatWeChatSummary(input.text)
  const facts = ctx.outboundDeliveryFacts
  if (!facts || media.buffer && (!facts.hasAttachment || !facts.attachmentAuthorized || facts.attachmentContentVersion !== media.contentVersion ||
      facts.checkedAttachmentContentVersion !== media.contentVersion || facts.attachmentPath !== media.resolvedPath ||
      facts.checkedAttachmentPath !== media.resolvedPath || await attachmentHasSensitiveMaterial(media, ctx.workDir))) {
    return { success: false, error: '微信外发缺少主进程最终检查事实' }
  }
  assertImOutboundAllowed(facts, { channel: 'wechat', body: input.text, sessionId: ctx.sessionId ?? '', recipient: input.userId })
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
    outboundDeliveryFacts?: ImOutboundFacts
  }
): Promise<{ success: boolean; chunksSent?: number; error?: string; diagnostic?: { caseId: string; retryable: boolean; category: 'mechanism' } }> {
  const bot = ctx.botService.getRawBot()
  if (!bot) return { success: false, error: '微信 Bot 未就绪' }

  let inboundRaw: IncomingMessage | undefined
  let deferredOwner: string | undefined
  if (ctx.sessionId) {
    inboundRaw = getWeChatBundle()?.router?.getInboundForSession(ctx.sessionId)
    if (!inboundRaw) {
      const session = ctx.sessionQueries.readSession(ctx.sessionId)
      const meta = session?.metadata as { source?: string } | undefined
      const facts = ctx.outboundDeliveryFacts
      const approvedOwner = facts?.trustedRecipient
      if (meta?.source !== 'wechat') return { success: false, error: '当前会话无有效微信上下文，无法回复' }
      if (!facts || facts.purpose !== 'task-reply' || !facts.userConfirmationReceipt?.trim() ||
        !approvedOwner || facts.identityKey !== approvedOwner || facts.ownerId !== approvedOwner || facts.recipient !== approvedOwner ||
        facts.modelRecipient || facts.chatType !== 'p2p') {
        return { success: false, error: '微信入站上下文已过期，请重新发送指令' }
      }
      // A deferred human approval outlives the platform reply object. The approved facts
      // still bind the owner, session, body, and attachment, so send directly to that owner.
      deferredOwner = approvedOwner
    }
  } else {
    return { success: false, error: '缺少会话上下文' }
  }

  if (inboundRaw) {
    const currentMessageId = inboundRaw.raw.client_id || `${inboundRaw.userId}-${inboundRaw.timestamp.getTime()}`
    if (ctx.expectedMessageId && currentMessageId !== ctx.expectedMessageId) {
      return { success: false, error: '微信入站消息已变化，请重新授权回复' }
    }
  }

  // final-check: external bytes are reachable only through the call-private, Agent-approved
  // prepared reply binding; readMedia rechecks regular-file identity and SHA-256 on the opened handle.
  const externalFacts = ctx.outboundDeliveryFacts
  const externalApproval = externalFacts?.purpose === 'task-reply' && externalFacts.chatType === 'p2p' &&
    Boolean(externalFacts.trustedRecipient && externalFacts.recipient === externalFacts.trustedRecipient &&
      externalFacts.ownerId === externalFacts.trustedRecipient && externalFacts.userConfirmationReceipt?.trim()) &&
    externalFacts.attachmentAuthorized && externalFacts.externalAttachmentReview &&
    externalFacts.attachmentPath === externalFacts.externalAttachmentReview.path &&
    externalFacts.attachmentContentVersion === externalFacts.externalAttachmentReview.sha256
    ? externalFacts.externalAttachmentReview : undefined
  const media = await readMedia(ctx.workDir, input.imagePath, input.filePath, externalApproval)
  if (media.error) return { success: false, error: media.error, ...(media.diagnostic ? { diagnostic: media.diagnostic } : {}) }
  if (ctx.signal?.aborted) return { success: false, error: '微信回复已取消' }

  const text = formatWeChatSummary(input.text)
  const facts = ctx.outboundDeliveryFacts
  if (!facts || media.buffer && (!facts.hasAttachment || !facts.attachmentAuthorized || facts.attachmentContentVersion !== media.contentVersion ||
      facts.checkedAttachmentContentVersion !== media.contentVersion || facts.attachmentPath !== media.resolvedPath ||
      facts.checkedAttachmentPath !== media.resolvedPath || await attachmentHasSensitiveMaterial(media, ctx.workDir))) {
    return { success: false, error: '微信外发缺少主进程最终检查事实' }
  }
  assertImOutboundAllowed(facts, { channel: 'wechat', body: input.text, sessionId: ctx.sessionId ?? '', recipient: deferredOwner ?? inboundRaw!.userId })
  try {
    if (deferredOwner) {
      if (media.buffer && media.fileName) {
        const ext = path.extname(media.fileName).toLowerCase()
        if (IMAGE_EXT.has(ext)) await bot.send(deferredOwner, { image: media.buffer, caption: text })
        else await bot.send(deferredOwner, { file: media.buffer, fileName: media.fileName, caption: text })
      } else await bot.send(deferredOwner, text)
    } else if (media.buffer && media.fileName) {
      const ext = path.extname(media.fileName).toLowerCase()
      if (IMAGE_EXT.has(ext)) {
        await bot.reply(inboundRaw!, { image: media.buffer, caption: text })
      } else {
        await bot.reply(inboundRaw!, { file: media.buffer, fileName: media.fileName, caption: text })
      }
    } else {
      await bot.reply(inboundRaw!, text)
    }
  } catch {
    throw new WeChatOutboundExecutionUncertainError('reply')
  }
  return { success: true, chunksSent: Math.max(1, Math.ceil(text.length / 2000)) }
}
