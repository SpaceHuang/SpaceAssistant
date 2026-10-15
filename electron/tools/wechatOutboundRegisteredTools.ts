import { createHash } from 'node:crypto'
import type { WeChatConfig } from '../../src/shared/wechatTypes'
import type { ImOutboundFacts } from '../../src/shared/confirmation/outboundClassification'
import { assessImOutboundContent } from '../../src/shared/confirmation/outboundClassification'
import { createImOutboundFacts } from '../../src/shared/confirmation/imOutboundFacts'
import { definePlannedTool, type RegisteredTool, type ToolExecutionContext } from './plannedToolRegistry'
import type { RemoteContext, ToolExecutionContext as RuntimeExecutionContext, ToolExecutor, ToolExecutorResult } from './types'
import { inspectWeChatTaskReplyAttachment } from './weChatToolExecutor'

const REMOTE_BINDING_KEYS = [
  'source', 'messageId', 'chatId', 'userId', 'outboundSessionId', 'authOwner',
  'authorizationGeneration', 'workDirProfileId', 'requestId', 'originSessionId', 'deferredAttachmentApproval'
] as const

type RemoteBinding = Readonly<Record<string, unknown>>
type PreparedOutbound = Readonly<{
  input: Record<string, unknown>
  workDir: string
  sessionId: string
  lane?: string
  remoteContextPresent: boolean
  remoteBinding?: RemoteBinding
  wechatConfig?: WeChatConfig
  outboundDeliveryFacts: ImOutboundFacts
}>

function runtimeContext(context: ToolExecutionContext): RuntimeExecutionContext {
  const runtime = context.runtimeContext as RuntimeExecutionContext | undefined
  if (!runtime) throw new Error('WECHAT_OUTBOUND_RUNTIME_CONTEXT_REQUIRED')
  return runtime
}

function remoteBinding(remote: RemoteContext | undefined): RemoteBinding | undefined {
  if (!remote) return undefined
  return Object.fromEntries(REMOTE_BINDING_KEYS.flatMap((key) =>
    remote[key] === undefined ? [] : [[key, remote[key]]]
  ))
}

function snapshot(runtime: RuntimeExecutionContext): Omit<PreparedOutbound, 'input' | 'outboundDeliveryFacts'> {
  return {
    workDir: runtime.workDir,
    sessionId: runtime.sessionId,
    ...(runtime.lane !== undefined ? { lane: runtime.lane } : {}),
    remoteContextPresent: runtime.remoteContext !== undefined,
    ...(remoteBinding(runtime.remoteContext) ? { remoteBinding: remoteBinding(runtime.remoteContext)! } : {}),
    ...(runtime.wechatConfig ? { wechatConfig: structuredClone(runtime.wechatConfig) } : {})
  }
}

async function deliveryFacts(name: 'wechat_send' | 'wechat_reply', input: Record<string, unknown>, runtime: RuntimeExecutionContext): Promise<ImOutboundFacts> {
  const remote = runtime.remoteContext
  const text = typeof input.text === 'string' ? input.text : undefined
  const modelRecipient = typeof input.userId === 'string' ? input.userId : undefined
  const requestedAttachment = typeof input.imagePath === 'string' || typeof input.filePath === 'string'
  const attachment = requestedAttachment
    ? await inspectWeChatTaskReplyAttachment(runtime.workDir, typeof input.imagePath === 'string' ? input.imagePath : undefined,
      typeof input.filePath === 'string' ? input.filePath : undefined)
    : { attachmentAuthorized: false }
  if (remote?.deferredAttachmentApproval) {
    const binding = remote.deferredAttachmentApproval
    if (!requestedAttachment || !attachment.attachmentPath || attachment.attachmentPath !== binding.path ||
      attachment.attachmentContentVersion !== binding.sha256 || attachment.checkedAttachmentContentVersion !== binding.sha256) {
      throw new Error('WECHAT_DEFERRED_ATTACHMENT_APPROVAL_MISMATCH')
    }
  }
  const textAssessment = text === undefined ? 'unknown' : assessImOutboundContent(text)
  const textFacts = text === undefined ? undefined : await createImOutboundFacts(text)
  const taskReplyBindingValid = name === 'wechat_reply' && !modelRecipient && remote?.source === 'wechat' &&
    Boolean(remote.userId && remote.authOwner === remote.userId && remote.originSessionId === runtime.sessionId &&
      remote.currentUserMessageId && remote.taskBinding)
  const controlledTaskReply = taskReplyBindingValid && textAssessment === 'ordinary' &&
    (!requestedAttachment || attachment.attachmentAuthorized)
  const originSessionId = remote?.originSessionId ??
    (name === 'wechat_send' && runtime.lane === 'desktop' ? runtime.sessionId : undefined)
  return {
    channel: 'wechat',
    purpose: name === 'wechat_reply' ? 'task-reply' : 'active-send',
    ...(originSessionId ? { originSessionId } : {}),
    activeSessionId: runtime.sessionId,
    ...(remote?.userId ? { identityKey: remote.userId } : {}),
    ...(remote?.authOwner ? { ownerId: remote.authOwner } : {}),
    ...(name === 'wechat_reply' && remote?.userId ? { trustedRecipient: remote.userId } : {}),
    ...(name === 'wechat_send' && typeof input.userId === 'string' ? { recipient: input.userId } : {}),
    ...(name === 'wechat_reply' && remote?.userId ? { recipient: modelRecipient ?? remote.userId } : {}),
    ...(modelRecipient ? { modelRecipient } : {}),
    chatType: taskReplyBindingValid ? 'p2p' : 'unknown',
    ...(text !== undefined ? { content: text } : {}),
    ...(text !== undefined ? { contentAssessment: { source: 'host' as const, content: text,
      classification: textAssessment,
      classifierVersion: 'host-im-outbound-v1' }, contentFacts: textFacts } : {}),
    contentCompleteness: controlledTaskReply ? 'complete' : 'unknown',
    hasAttachment: requestedAttachment,
    ...attachment
  }
}

function fingerprint(value: Omit<PreparedOutbound, 'input'>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function preparedSnapshot(prepared: PreparedOutbound): Omit<PreparedOutbound, 'input'> {
  return {
    workDir: prepared.workDir,
    sessionId: prepared.sessionId,
    ...(prepared.lane !== undefined ? { lane: prepared.lane } : {}),
    remoteContextPresent: prepared.remoteContextPresent,
    ...(prepared.remoteBinding ? { remoteBinding: prepared.remoteBinding } : {}),
    ...(prepared.wechatConfig ? { wechatConfig: prepared.wechatConfig } : {}),
    outboundDeliveryFacts: prepared.outboundDeliveryFacts
  }
}

function registerOutbound(name: 'wechat_send' | 'wechat_reply', executor: ToolExecutor): RegisteredTool {
  return definePlannedTool<Record<string, unknown>, PreparedOutbound, ToolExecutorResult>({
    name,
    actionClass: 'outbound',
    parseInput: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('WECHAT_OUTBOUND_INPUT_INVALID')
      return structuredClone(raw as Record<string, unknown>)
    },
    plan: async (input, planning) => {
      if (!planning.executionContext) throw new Error('WECHAT_OUTBOUND_RUNTIME_CONTEXT_REQUIRED')
      const delivery = await deliveryFacts(name, input, planning.executionContext)
      return { input: structuredClone(input), ...snapshot(planning.executionContext), outboundDeliveryFacts: delivery }
    },
    validate: async (prepared, execution) => {
      const runtime = runtimeContext(execution)
      const current = { ...snapshot(runtime), outboundDeliveryFacts: await deliveryFacts(name, prepared.input, runtime) }
      if (fingerprint(current) !== fingerprint(preparedSnapshot(prepared))) {
        throw new Error('WECHAT_OUTBOUND_PREPARED_BINDING_CHANGED')
      }
    },
    execute: async (prepared, execution) => {
      const runtime = runtimeContext(execution)
      const remoteContext = runtime.remoteContext && prepared.remoteBinding
        ? { ...runtime.remoteContext, ...prepared.remoteBinding } as RemoteContext
        : runtime.remoteContext
      const outboundDeliveryFacts = structuredClone(prepared.outboundDeliveryFacts)
      if (outboundDeliveryFacts.attachmentApprovalRequired) {
        const receipt = execution.userConfirmationReceipt?.trim()
        const exactPreparedAttachment = outboundDeliveryFacts.attachmentPath &&
          outboundDeliveryFacts.attachmentPath === outboundDeliveryFacts.checkedAttachmentPath &&
          outboundDeliveryFacts.attachmentContentVersion &&
          outboundDeliveryFacts.attachmentContentVersion === outboundDeliveryFacts.checkedAttachmentContentVersion
        const deferredBinding = remoteContext?.deferredAttachmentApproval
        if (!receipt || execution.userConfirmationAnswerer !== 'user' || !exactPreparedAttachment || (deferredBinding &&
          (deferredBinding.path !== outboundDeliveryFacts.attachmentPath || deferredBinding.sha256 !== outboundDeliveryFacts.attachmentContentVersion))) {
          throw new Error('WECHAT_ATTACHMENT_HUMAN_APPROVAL_BINDING_REQUIRED')
        }
        outboundDeliveryFacts.attachmentAuthorized = true
      }
      return executor.execute(prepared.input, {
        ...runtime,
        workDir: prepared.workDir,
        sessionId: prepared.sessionId,
        ...(prepared.lane !== undefined ? { lane: prepared.lane } : {}),
        ...(remoteContext ? { remoteContext } : {}),
        ...(prepared.wechatConfig ? { wechatConfig: structuredClone(prepared.wechatConfig) } : {}),
        outboundDeliveryFacts: {
          ...outboundDeliveryFacts,
          ...(execution.userConfirmationReceipt ? { userConfirmationReceipt: execution.userConfirmationReceipt } : {})
        },
        requestId: execution.requestId,
        toolUseId: execution.toolUseId,
        signal: execution.signal
      })
    },
    facts: (prepared) => ({
      bindingHash: fingerprint(preparedSnapshot(prepared)),
      inputHash: createHash('sha256').update(JSON.stringify(prepared.input)).digest('hex')
    }),
    display: (prepared) => ({
      toolName: name,
      recipient: name === 'wechat_send' && typeof prepared.input.userId === 'string' ? prepared.input.userId : undefined
    })
  })
}

/** Freeze recipient/session/config facts for WeChat outbound effects before dispatch. */
export function createWeChatOutboundRegisteredTools(executors: {
  send: ToolExecutor
  reply: ToolExecutor
}): readonly RegisteredTool[] {
  return [
    registerOutbound('wechat_send', executors.send),
    registerOutbound('wechat_reply', executors.reply)
  ]
}
