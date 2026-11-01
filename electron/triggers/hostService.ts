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
  const isSourceAuthorized = (ownerSessionId: string, receiverSessionId: string, condition: import('../../src/shared/domainTypes').RuntimeTriggerCondition,
    sourceBaseline?: Readonly<Record<string, unknown>>) => {
    if (!sameProfile(ownerSessionId, receiverSessionId)) return false
    const owner = visibleSessions().find((session) => session.id === ownerSessionId)
    if (!owner) return false
    if (condition.type === 'time') return true
    if (condition.type === 'process_exit') {
      if (listProcesses(ownerSessionId).some((target) => target.id === condition.managedProcessId)) return true
      const generation = sourceBaseline?.runtimeGeneration
      if (typeof generation !== 'string') return false
      const exit = readManagedProcessExit(condition.managedProcessId, generation)
      return exit.ok && exit.sessionId === ownerSessionId
    }
    if (condition.type === 'im_message') {
      if (ownerSessionId !== receiverSessionId) return false
      const metadata = owner.metadata as Record<string, unknown> | undefined
      const conversationMatches = condition.channel === 'feishu'
        ? metadata?.source === 'feishu' && metadata.feishuChatId === condition.conversationId
        : metadata?.source === 'wechat' && (metadata.wechatMeta as { userId?: unknown } | undefined)?.userId === condition.conversationId
      if (!conversationMatches) return false
      try {
        const frontier = input.queries.imAcceptedFacts.captureFrontier({ channel: condition.channel,
          accountId: condition.accountId, conversationId: condition.conversationId })
        return Number.isSafeInteger(frontier.through) && frontier.through > 0
      } catch { return false }
    }
    return sameProfile(ownerSessionId, condition.targetSessionId)
  }
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
        return { settledCount: facts.settledCount }
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
    resolveQueueScope,
    async register(request: Parameters<typeof service.register>[0]) {
      if (input.accepting && !input.accepting()) throw new Error('TRIGGER_ADMISSION_CLOSED')
      return register(request)
    }
  })
}
