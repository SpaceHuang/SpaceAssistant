import type { RuntimeTriggerTargetDto } from '../../src/shared/domainTypes'
import type { SessionCommands, SessionQueries } from '../sessionStorage/public/ports'
import type { SessionExecutionStore } from '../sessionStorage/public/execution'
import { buildImQueueScope, type QueueScope } from '../../src/shared/queueScope'
import { createRuntimeTriggerService } from './service'
import { listManagedProcessTargets, managedProcessRuntimeGeneration, readManagedProcessExit } from './processSource'
import { readSessionSettledStepFacts } from './sources'

/** Host facts used by capability registration. Authorization is derived from current session and source records. */
export function createRuntimeTriggerHostService(input: {
  commands: SessionCommands
  queries: SessionQueries
  execution: Pick<SessionExecutionStore, 'historyFor'>
  listProcesses?: typeof listManagedProcessTargets
  processGeneration?: typeof managedProcessRuntimeGeneration
  authorizeImSource?: (source: Readonly<{ channel: 'feishu' | 'wechat'; accountId: string; conversationId: string; senderId: string }>) =>
    Readonly<{ allowed: boolean; policyTrace?: Readonly<Record<string, unknown>> }>
  accepting?: () => boolean
  cancelSyncWait?: (record: import('../sessionStorage/public/model').RuntimeTriggerRecord) => void
}) {
  const listProcesses = input.listProcesses ?? listManagedProcessTargets
  const processGeneration = input.processGeneration ?? managedProcessRuntimeGeneration
  const visibleSessions = () => input.queries.listSessions({ view: 'user-visible' })
  const sameProfile = (leftId: string, rightId: string) => {
    const sessions = visibleSessions()
    const left = sessions.find((session) => session.id === leftId)
    const right = sessions.find((session) => session.id === rightId)
    return Boolean(left && right && left.workDirProfileId === right.workDirProfileId)
  }
  const authorizeSource = (ownerSessionId: string, receiverSessionId: string, condition: import('../../src/shared/domainTypes').RuntimeTriggerCondition,
    sourceBaseline?: Readonly<Record<string, unknown>>, sourceEvent?: Readonly<Record<string, unknown>>) => {
    const reject = () => ({ allowed: false as const })
    if (!sameProfile(ownerSessionId, receiverSessionId)) return reject()
    const owner = visibleSessions().find((session) => session.id === ownerSessionId)
    if (!owner) return reject()
    if (condition.type === 'time') return { allowed: true as const }
    if (condition.type === 'process_exit') {
      if (listProcesses(ownerSessionId).some((target) => target.id === condition.managedProcessId)) return { allowed: true as const }
      const generation = sourceBaseline?.runtimeGeneration
      if (typeof generation !== 'string') return reject()
      const exit = readManagedProcessExit(condition.managedProcessId, generation)
      return exit.kind === 'terminal' && exit.sessionId === ownerSessionId ? { allowed: true as const } : reject()
    }
    if (condition.type === 'im_message') {
      if (ownerSessionId !== receiverSessionId || !input.authorizeImSource) return reject()
      const metadata = owner.metadata as Record<string, unknown> | undefined
      const metadataSource = condition.channel
      const boundSenderId = condition.channel === 'feishu' ? metadata?.feishuSenderOpenId
        : (metadata?.wechatMeta as { userId?: unknown } | undefined)?.userId
      const conversationMatches = condition.channel === 'feishu'
        ? metadata?.source === metadataSource && metadata.feishuChatId === condition.conversationId
        : metadata?.source === metadataSource && boundSenderId === condition.conversationId
      if (!conversationMatches || typeof boundSenderId !== 'string' || !boundSenderId.trim()) return reject()
      if (sourceEvent && (sourceEvent.type !== 'im_message' || sourceEvent.channel !== condition.channel ||
        sourceEvent.accountId !== condition.accountId || sourceEvent.conversationId !== condition.conversationId ||
        typeof sourceEvent.senderId !== 'string' || sourceEvent.senderId !== boundSenderId ||
        (condition.senderIds && !condition.senderIds.includes(sourceEvent.senderId)))) return reject()
      const senderIds = sourceEvent ? [sourceEvent.senderId as string] : condition.senderIds?.length ? [...condition.senderIds] : [boundSenderId]
      if (senderIds.some((senderId) => senderId !== boundSenderId)) return reject()
      try {
        const frontier = input.queries.imAcceptedFacts.captureFrontier({ channel: condition.channel,
          accountId: condition.accountId, conversationId: condition.conversationId })
        if (!Number.isSafeInteger(frontier.through) || frontier.through <= 0) return reject()
        const decisions = senderIds.map((senderId) => input.authorizeImSource!({ channel: condition.channel, accountId: condition.accountId,
          conversationId: condition.conversationId, senderId }))
        if (decisions.some((decision) => !decision.allowed || !decision.policyTrace)) return reject()
        return { allowed: true as const, policyTrace: decisions.map((decision) => decision.policyTrace!) }
      } catch { return reject() }
    }
    return sameProfile(ownerSessionId, condition.targetSessionId) ? { allowed: true as const } : reject()
  }
  const isSourceAuthorized = (ownerSessionId: string, receiverSessionId: string, condition: import('../../src/shared/domainTypes').RuntimeTriggerCondition,
    sourceBaseline?: Readonly<Record<string, unknown>>, sourceEvent?: Readonly<Record<string, unknown>>) =>
    authorizeSource(ownerSessionId, receiverSessionId, condition, sourceBaseline, sourceEvent).allowed
  const resolveQueueScope = (receiverSessionId: string): QueueScope | undefined => {
    const session = input.queries.readSession(receiverSessionId)
    if (!session) return undefined
    const metadata = session.metadata as Record<string, unknown> | undefined
    if (metadata?.source === 'feishu') return buildImQueueScope('feishu', receiverSessionId)
    if (metadata?.source === 'wechat') return buildImQueueScope('wechat', receiverSessionId)
    return { kind: 'desktop' }
  }
  const service = createRuntimeTriggerService(input.commands, {
    cancelSyncWait: input.cancelSyncWait,
    authorize: ({ ownerSessionId, receiverSessionId, condition }) => isSourceAuthorized(ownerSessionId, receiverSessionId, condition),
    authorizeTarget: ({ ownerSessionId, target }) => {
      if (target.kind === 'managed-process') return listProcesses(ownerSessionId).some((item) => item.id === target.id)
      return sameProfile(ownerSessionId, target.id)
    },
    listTargets: (ownerSessionId): readonly RuntimeTriggerTargetDto[] => {
      const sessions = visibleSessions()
      const owner = sessions.find((session) => session.id === ownerSessionId)
      if (!owner) return []
      return [
        ...sessions.filter((session) => session.workDirProfileId === owner.workDirProfileId)
          .map((session) => ({ kind: 'session' as const, id: session.id, label: session.name })),
        ...listProcesses(ownerSessionId)
      ]
    },
    resolveBaseline: async ({ condition }) => {
      if (condition.type === 'session_steps') {
        const facts = await readSessionSettledStepFacts(input.execution, condition.targetSessionId)
        if (!facts.ok) throw new Error(facts.case ?? 'step-baseline-unavailable')
        return { settledCount: facts.settledCount, settledCountByInvocation: facts.settledCountByInvocation ?? {} }
      }
      if (condition.type === 'process_exit') return { runtimeGeneration: processGeneration() }
      if (condition.type === 'im_message') return input.queries.imAcceptedFacts.captureFrontier({
        channel: condition.channel, accountId: condition.accountId, conversationId: condition.conversationId
      })
      return {}
    }
  })
  const register = service.register.bind(service)
  return Object.assign(service, {
    isSourceAuthorized,
    authorizeSource,
    resolveQueueScope,
    async register(request: Parameters<typeof service.register>[0]) {
      if (input.accepting && !input.accepting()) throw new Error('TRIGGER_ADMISSION_CLOSED')
      return register(request)
    }
  })
}
