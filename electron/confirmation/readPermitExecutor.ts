import fs from 'fs/promises'
import { constants as fsConstants } from 'fs'
import path from 'path'
import type { FileHandle } from 'fs/promises'
import { validateReadExecutionPermit } from './readExecutionPermit'
import type { ToolExecutionContext } from '../tools/types'
import type { ReadExecutionPermit } from './readExecutionPermit'
import { recordPolicyExecutionVeto } from './audit'
import type { ExecutionLane } from '../../src/shared/confirmation/types'
import { findRegisteredFeishuAttachment, MAX_FEISHU_ATTACHMENT_BYTES } from '../feishu/feishuAttachmentRegistry'
import { isPathWithinGrantedDirectory, normalizeDirectoryGrantPath } from '../../src/shared/sessionDirectoryGrant'

type PermitResolveFailure = { ok: false; caseId: string; failureClass: 'input' | 'mechanism' | 'environment' | 'integration-violation'; factId?: string }
type FilePermitResolveSuccess = { ok: true; path: string; targetKind: 'file'; fileHandle: FileHandle }
type DirectoryPermitResolveSuccess = { ok: true; path: string; targetKind: 'directory' }
type FeishuPermitResolveSuccess = { ok: true; path: string; content: Buffer }

export function resolveReadPermitTarget(toolName: 'read_file' | 'grep', input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<FilePermitResolveSuccess | DirectoryPermitResolveSuccess | PermitResolveFailure>
export function resolveReadPermitTarget(toolName: 'list_directory', input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<DirectoryPermitResolveSuccess | PermitResolveFailure>
export function resolveReadPermitTarget(toolName: 'read_feishu_attachment', input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<FeishuPermitResolveSuccess | PermitResolveFailure>
export async function resolveReadPermitTarget(toolName: 'read_file' | 'grep' | 'list_directory' | 'read_feishu_attachment', input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<FilePermitResolveSuccess | DirectoryPermitResolveSuccess | FeishuPermitResolveSuccess | PermitResolveFailure> {
  const permit: ReadExecutionPermit | undefined = ctx.readExecutionPermit
  const deny = (caseId: string, failureClass: 'input' | 'mechanism' | 'environment' | 'integration-violation') => {
    recordPolicyExecutionVeto({ audit: ctx.audit, lane: (ctx.lane as ExecutionLane | undefined) ?? 'desktop', sessionId: ctx.sessionId, requestId: ctx.requestId, toolUseId: ctx.toolUseId, toolName, decisionRuleId: permit?.decisionRuleId, pathZone: permit?.targets[0]?.zone, factId: permit?.targets[0]?.factId, failureClass, caseId })
    return { ok: false as const, caseId, failureClass, ...(permit?.targets[0]?.factId ? { factId: permit.targets[0].factId } : {}) }
  }
  if (ctx.signal?.aborted) return deny('read-permit-cancelled', 'environment')
  const feishuAttachment = toolName === 'read_feishu_attachment'
    ? findRegisteredFeishuAttachment(ctx.remoteContext?.source === 'feishu' ? ctx.remoteContext.feishuAttachments : undefined, input.attachmentId)
    : undefined
  if (toolName === 'read_feishu_attachment' && (!feishuAttachment || feishuAttachment.messageId !== ctx.remoteContext?.messageId)) {
    return deny('read-attachment-not-registered', 'input')
  }
  if (!permit) return deny('read-permit-missing', 'integration-violation')
  const validation = validateReadExecutionPermit(permit, { requestId: ctx.requestId, toolUseId: ctx.toolUseId, toolName, input, facts: permit.targets })
  if (!validation.ok) return deny(validation.caseId, validation.caseId === 'input-digest-mismatch' ? 'input' : 'integration-violation')
  if (permit.targets.length !== 1) return deny('permit-target-count-mismatch', 'integration-violation')
  const target = permit.targets[0]!
  if (target.directoryGrant) {
    const grant = target.directoryGrant
    if ((ctx.lane as ExecutionLane | undefined) !== 'desktop' || ctx.sessionId !== grant.sessionId || !grant.grantId) return deny('read-directory-grant-binding-mismatch', 'integration-violation')
    if (!ctx.isSessionDirectoryGrantActive?.(grant)) return deny('read-directory-grant-revoked', 'mechanism')
    try {
      const realRoot = await fs.realpath(grant.realPath)
      const stat = await fs.stat(realRoot)
      if (normalizeDirectoryGrantPath(realRoot) !== normalizeDirectoryGrantPath(grant.realPath) || !stat.isDirectory() ||
        stat.dev !== grant.identity.dev || stat.ino !== grant.identity.ino || stat.mode !== grant.identity.mode) {
        return deny('read-directory-grant-identity-changed', 'mechanism')
      }
      if (!isPathWithinGrantedDirectory(target.normalizedPath, realRoot)) return deny('read-directory-grant-scope-mismatch', 'mechanism')
    } catch {
      return deny('read-directory-grant-unavailable', 'environment')
    }
  }
  if (toolName === 'list_directory') {
    if (target.targetKind !== 'directory' || target.scope !== 'direct-entries' || !target.identity) return deny('permit-target-kind-not-enumerable', 'mechanism')
    try {
      // 目录 identity 只绑 dev/ino/mode：size/mtimeMs 随子条目增删即变，不代表「内容变更」（§5.3 B2）
      // realpath 失败与 identity 变化分 caseId 上报（§15.1 C8，AC-50）
      if (await fs.realpath(target.normalizedPath) !== target.normalizedPath) return deny('read-directory-realpath-changed', 'mechanism')
      const stat = await fs.stat(target.normalizedPath)
      if (!stat.isDirectory() || stat.dev !== target.identity.dev || stat.ino !== target.identity.ino || stat.mode !== target.identity.mode) {
        return deny('read-directory-identity-changed', 'mechanism')
      }
      return { ok: true, path: target.normalizedPath, targetKind: 'directory' }
    } catch {
      return deny('read-directory-unavailable', 'environment')
    }
  }
  // grep 目录递归：绑定根目录 identity（dev/ino/mode），realpath 防「根被换成链接」（§5.3）
  if (toolName === 'grep' && target.targetKind === 'directory') {
    if (target.scope !== 'subtree' || !target.identity) return deny('permit-target-scope-mismatch', 'mechanism')
    try {
      if (await fs.realpath(target.normalizedPath) !== target.normalizedPath) return deny('read-directory-realpath-changed', 'mechanism')
      const stat = await fs.stat(target.normalizedPath)
      if (!stat.isDirectory() || stat.dev !== target.identity.dev || stat.ino !== target.identity.ino || stat.mode !== target.identity.mode) {
        return deny('read-directory-identity-changed', 'mechanism')
      }
      return { ok: true, path: target.normalizedPath, targetKind: 'directory' }
    } catch {
      return deny('read-directory-unavailable', 'environment')
    }
  }
  if (target.targetKind === 'directory' || target.targetKind === 'special' || target.targetKind === 'unknown') return deny('permit-target-kind-not-readable', 'mechanism')
  if (target.targetKind === 'missing') return deny('read-target-missing', 'environment')
  if (!target.identity) return deny('read-target-identity-missing', 'mechanism')
  if (toolName === 'read_feishu_attachment') {
    const attachment = feishuAttachment!
    let fileHandle: FileHandle | undefined
    try {
      const root = await fs.realpath(path.resolve(ctx.userDataDir, 'feishu-media'))
      const realPath = await fs.realpath(attachment.localPath)
      const relative = path.relative(root, realPath)
      if (realPath !== target.normalizedPath || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return deny('read-target-path-mismatch', 'input')
      }
      fileHandle = await fs.open(attachment.localPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0))
      const stat = await fileHandle.stat()
      if (!stat.isFile() || stat.dev !== target.identity.dev || stat.ino !== target.identity.ino || stat.mode !== target.identity.mode || stat.size !== target.identity.size || stat.mtimeMs !== target.identity.mtimeMs) {
        await fileHandle.close()
        return deny('read-target-identity-changed', 'mechanism')
      }
      const openedPath = await fs.realpath(attachment.localPath)
      const openedRelative = path.relative(root, openedPath)
      if (openedPath !== target.normalizedPath || openedRelative === '..' || openedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(openedRelative)) {
        await fileHandle.close()
        return deny('read-target-path-mismatch', 'mechanism')
      }
      if (stat.size > MAX_FEISHU_ATTACHMENT_BYTES) {
        await fileHandle.close()
        return deny('read-target-too-large', 'environment')
      }
      const content = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < content.length) {
        if (ctx.signal?.aborted) {
          await fileHandle.close()
          return deny('read-permit-cancelled', 'environment')
        }
        const { bytesRead } = await fileHandle.read(content, offset, content.length - offset, null)
        if (bytesRead <= 0) {
          await fileHandle.close()
          return deny('read-target-changed-during-read', 'environment')
        }
        offset += bytesRead
      }
      if (ctx.signal?.aborted) {
        await fileHandle.close()
        return deny('read-permit-cancelled', 'environment')
      }
      const after = await fileHandle.stat()
      await fileHandle.close()
      if (after.dev !== stat.dev || after.ino !== stat.ino || after.mode !== stat.mode || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
        return deny('read-target-changed-during-read', 'mechanism')
      }
      return { ok: true, path: target.normalizedPath, content }
    } catch (error) {
      await fileHandle?.close().catch(() => undefined)
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
      return deny(code === 'READ_TARGET_IDENTITY_CHANGED' ? 'read-target-identity-changed' : 'read-target-unavailable', code === 'READ_TARGET_IDENTITY_CHANGED' ? 'mechanism' : 'environment')
    }
  }
  let fileHandle: FileHandle
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0
    const nonBlocking = fsConstants.O_NONBLOCK ?? 0
    fileHandle = await fs.open(target.normalizedPath, fsConstants.O_RDONLY | noFollow | nonBlocking)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ELOOP') {
      return deny('read-target-symlink-changed', 'mechanism')
    }
    return deny('read-target-unavailable', 'environment')
  }
  try {
    const stat = await fileHandle.stat()
    if (!stat.isFile() || stat.dev !== target.identity.dev || stat.ino !== target.identity.ino || stat.mode !== target.identity.mode || stat.size !== target.identity.size || stat.mtimeMs !== target.identity.mtimeMs) {
      await fileHandle.close()
      return deny('read-target-identity-changed', 'mechanism')
    }
    if (await fs.realpath(target.normalizedPath) !== target.normalizedPath) {
      await fileHandle.close()
      return deny('read-target-identity-changed', 'mechanism')
    }
    return { ok: true, path: target.normalizedPath, targetKind: 'file', fileHandle }
  } catch {
    await fileHandle.close().catch(() => undefined)
    return deny('read-target-unavailable', 'environment')
  }
}
