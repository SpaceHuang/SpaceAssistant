import type { RuntimeTriggerCondition } from '../../src/shared/domainTypes'
import type { SessionQueries } from '../sessionStorage/public/ports'
import type { ImAcceptedFact, ImAcceptedFactFrontier, ImAcceptedFactScope } from '../sessionStorage/public/model'

export type ImTriggerMatch = Readonly<ImAcceptedFact & { body: string }>
export type ImTriggerFactScan = Readonly<{ ok: true; frontier: ImAcceptedFactFrontier; matches: readonly ImTriggerMatch[] }> |
  Readonly<{ ok: false; code: 'TRIGGER_SOURCE_GAP'; case: string }>

export function captureImTriggerBaseline(queries: SessionQueries, condition: Extract<RuntimeTriggerCondition, { type: 'im_message' }>): ImAcceptedFactFrontier {
  return queries.imAcceptedFacts.captureFrontier({ channel: condition.channel, accountId: condition.accountId, conversationId: condition.conversationId })
}

export function scanImTriggerFacts(queries: SessionQueries, condition: Extract<RuntimeTriggerCondition, { type: 'im_message' }>, options: { pageSize: number; baseline: ImAcceptedFactFrontier }): ImTriggerFactScan {
  const scope: ImAcceptedFactScope = { channel: condition.channel, accountId: condition.accountId, conversationId: condition.conversationId }
  try {
    if (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100) return { ok: false, code: 'TRIGGER_SOURCE_GAP', case: 'im-page-size-invalid' }
    const frontier = queries.imAcceptedFacts.captureFrontier(scope)
    if (!Number.isSafeInteger(frontier.through) || frontier.through < 0 || !Number.isSafeInteger(frontier.coverageRevision) || frontier.coverageRevision < 0) {
      return { ok: false, code: 'TRIGGER_SOURCE_GAP', case: 'im-frontier-invalid' }
    }
    if (!options.baseline || !Number.isSafeInteger(options.baseline.through) || options.baseline.through < 0 ||
      !Number.isSafeInteger(options.baseline.coverageRevision) || options.baseline.coverageRevision !== frontier.coverageRevision ||
      options.baseline.through > frontier.through) return { ok: false, code: 'TRIGGER_SOURCE_GAP', case: 'im-baseline-invalid-or-coverage-changed' }
    const matches: ImTriggerMatch[] = []
    let after = options.baseline.through
    while (true) {
      const page = queries.imAcceptedFacts.readPage({ ...scope, ...frontier, after, limit: options.pageSize })
      let previous = after
      for (const fact of page.items) {
        if (fact.channel !== scope.channel || fact.accountId !== scope.accountId || fact.conversationId !== scope.conversationId ||
          !Number.isSafeInteger(fact.acceptedSeq) || fact.acceptedSeq <= previous || fact.acceptedSeq > frontier.through ||
          !fact.messageId.trim() || !fact.senderId.trim() || !fact.platformMessageId.trim()) return { ok: false, code: 'TRIGGER_SOURCE_GAP', case: 'im-fact-invalid' }
        previous = fact.acceptedSeq
        const body = queries.imAcceptedFacts.readBody({ ...scope, messageId: fact.messageId })
        if (typeof body !== 'string') return { ok: false, code: 'TRIGGER_SOURCE_GAP', case: 'im-body-unavailable' }
        if ((!condition.senderIds || condition.senderIds.includes(fact.senderId)) &&
          (condition.bodyContains === undefined || body.includes(condition.bodyContains))) matches.push({ ...fact, body })
      }
      if (page.nextAfter === undefined) {
        break
      }
      if (!Number.isSafeInteger(page.nextAfter) || page.nextAfter <= after || page.nextAfter !== previous) return { ok: false, code: 'TRIGGER_SOURCE_GAP', case: 'im-cursor-invalid' }
      after = page.nextAfter
    }
    return { ok: true, frontier, matches }
  } catch {
    return { ok: false, code: 'TRIGGER_SOURCE_GAP', case: 'im-read-failed' }
  }
}
