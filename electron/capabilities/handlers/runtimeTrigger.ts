import { z } from 'zod'
import type { CapabilityDescriptor } from '../types'

const nonEmpty = z.string().trim().min(1)
const sourceCondition = z.union([
  z.object({ type: z.literal('turn_completed'), targetSessionId: nonEmpty, turnId: nonEmpty }).strict(),
  z.union([
    z.object({ type: z.literal('session_steps'), targetSessionId: nonEmpty, origin: z.literal('registration'), threshold: z.number().int().positive(), mode: z.literal('async') }).strict(),
    z.object({ type: z.literal('session_steps'), targetSessionId: nonEmpty, origin: z.literal('registration'), threshold: z.number().int().positive(), mode: z.literal('sync'), pauseTimeoutMs: z.number().positive(), onPauseTimeout: z.enum(['continue', 'fail']) }).strict()
  ]),
  z.object({ type: z.literal('process_exit'), managedProcessId: nonEmpty }).strict(),
  z.object({ type: z.literal('im_message'), channel: z.enum(['feishu', 'wechat']), accountId: nonEmpty, conversationId: nonEmpty,
    senderIds: z.array(nonEmpty).optional(), bodyContains: nonEmpty.optional() }).strict(),
  z.object({ type: z.literal('time'), at: nonEmpty.regex(/([zZ]|[+-]\d{2}:?\d{2})$/).refine((value) => Number.isFinite(Date.parse(value))), taskPrompt: nonEmpty }).strict()
])

const targetsCapability: CapabilityDescriptor = {
  id: 'action.runtime_trigger.targets', family: 'action', risk: 'read',
  summary: '列出当前有权使用的会话、受管进程等运行时触发目标',
  keywords: ['运行时触发目标', '监督会话', '受管进程', '触发器目标', 'runtime trigger targets'],
  paramsSchema: z.object({ cursor: nonEmpty.optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  paramsDoc: '{ "cursor"?: string, "limit"?: 1..100 }；先查可用目标，再登记准确 ID',
  returnsDoc: '{ items: [{ kind, id, label?, status? }], nextCursor? }',
  handler: async (params, ctx) => requireService(ctx).targets({ ownerSessionId: ctx.sessionId, params })
}

const registerCapability: CapabilityDescriptor = {
  id: 'action.runtime_trigger.register', family: 'action', risk: 'act',
  summary: '按准确来源条件一次性登记运行时触发器；用 clientKey 保证重试幂等',
  keywords: ['等待 Turn 完成', '另一个会话完成', '按步监督', '监督本会话步骤', '进程退出', '受管进程退出', '飞书微信消息', '飞书消息触发', '定时唤醒', 'runtime trigger register'],
  paramsSchema: z.object({ clientKey: nonEmpty, receiverSessionId: nonEmpty, expiresAt: z.number().int().positive(), condition: sourceCondition }).strict(),
  paramsDoc: '{ "clientKey", "receiverSessionId", "expiresAt": epoch 毫秒, "condition": turn_completed|session_steps(async/sync)|process_exit|im_message|time }；缺目标先调用 targets',
  returnsDoc: '{ trigger: { triggerId, state, revision, expiresAt }, replayed? }',
  notes: ['变更操作经既有 policy 确认', '命中后系统会唤醒接收会话；来源正文不会写入队列标记', '同步监督会暂停目标 Turn，pauseTimeoutMs 受宿主上限约束', '队列唤醒标记不包含来源正文'],
  handler: async (params, ctx) => requireService(ctx).register({ ownerSessionId: ctx.sessionId, params })
}

const getCapability: CapabilityDescriptor = {
  id: 'action.runtime_trigger.get', family: 'action', risk: 'read',
  summary: '查询本人已登记触发器的状态、当前修订和失败原因',
  keywords: ['触发器状态', '等待结果', '投递失败', 'trigger status', 'runtime trigger get'],
  paramsSchema: z.object({ triggerId: nonEmpty }).strict(),
  paramsDoc: '{ "triggerId": "登记时返回的 ID" }',
  returnsDoc: '{ trigger: { triggerId, state, revision, failure? } }',
  handler: async (params, ctx) => requireService(ctx).get({ ownerSessionId: ctx.sessionId, triggerId: (params as { triggerId: string }).triggerId })
}

const listCapability: CapabilityDescriptor = {
  id: 'action.runtime_trigger.list', family: 'action', risk: 'read',
  summary: '分页查看本人已有触发器登记，避免重复创建',
  keywords: ['我的触发器', '已登记等待', 'runtime trigger list', '触发器列表'],
  paramsSchema: z.object({ cursor: nonEmpty.optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  paramsDoc: '{ "cursor"?: string, "limit"?: 1..100 }',
  returnsDoc: '{ items: [{ triggerId, state, revision, expiresAt }], nextCursor? }',
  handler: async (params, ctx) => requireService(ctx).list({ ownerSessionId: ctx.sessionId, params })
}

const cancelCapability: CapabilityDescriptor = {
  id: 'action.runtime_trigger.cancel', family: 'action', risk: 'act',
  summary: '取消本人等待中的触发器；先查询最新 revision 并使用 expectedRevision',
  keywords: ['取消等待', '停止监督', '撤销触发器', 'runtime trigger cancel'],
  paramsSchema: z.object({ triggerId: nonEmpty, expectedRevision: z.number().int().positive() }).strict(),
  paramsDoc: '{ "triggerId": string, "expectedRevision": integer }；若 revision 已变化，请重新 get',
  returnsDoc: '{ trigger: { triggerId, state: "cancelled", revision } }',
  notes: ['变更操作经既有 policy 确认', '命中后的同步等待会解除当前在线暂停'],
  handler: async (params, ctx) => requireService(ctx).cancel({ ownerSessionId: ctx.sessionId, params })
}

export function createRuntimeTriggerCapabilities(): CapabilityDescriptor[] {
  return [targetsCapability, registerCapability, getCapability, listCapability, cancelCapability]
}

function requireService(ctx: import('../types').CapabilityContext): NonNullable<import('../types').CapabilityContext['runtimeTriggers']> {
  if (!ctx.runtimeTriggers) throw new Error('runtime trigger service unavailable')
  return ctx.runtimeTriggers
}
