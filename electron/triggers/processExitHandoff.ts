import type { SessionCommands } from '../sessionStorage/public/ports'
import { subscribeManagedProcessExit, type ManagedProcessExitFact } from './processSource'

/** Persist waiting process-exit matches synchronously before the executor exposes its result. */
export function subscribeRuntimeTriggerProcessExitHandoff(
  commands: Pick<SessionCommands, 'runtimeTriggers'>,
  subscribe = subscribeManagedProcessExit
): () => void {
  return subscribe((exit) => {
    for (const trigger of commands.runtimeTriggers.listWaitingForManagedProcessExit({ managedProcessId: exit.managedProcessId,
      runtimeGeneration: exit.runtimeGeneration, ownerSessionId: exit.sessionId })) {
      const condition = trigger.definition.condition
      const runtimeGeneration = trigger.definition.sourceBaseline.runtimeGeneration
      if (condition.type !== 'process_exit' || condition.managedProcessId !== exit.managedProcessId || runtimeGeneration !== exit.runtimeGeneration) continue
      if (exit.occurredAt > trigger.expiresAt) {
        commands.runtimeTriggers.update(trigger.id, trigger.revision, { state: 'expired', updatedAt: exit.occurredAt })
        continue
      }
      commands.runtimeTriggers.update(trigger.id, trigger.revision, {
        state: 'matched', matchedAt: exit.occurredAt, updatedAt: exit.occurredAt, event: toProcessExitEvent(exit)
      })
    }
  })
}

function toProcessExitEvent(exit: ManagedProcessExitFact): Readonly<Record<string, unknown>> {
  return { type: 'process_exit', occurredAt: exit.occurredAt, managedProcessId: exit.managedProcessId,
    runtimeGeneration: exit.runtimeGeneration, sessionId: exit.sessionId, toolName: exit.toolName,
    exitCode: exit.exitCode, signal: exit.signal, reason: exit.reason, ...(exit.outputRef ? { outputRef: exit.outputRef } : {}) }
}
