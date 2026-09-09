import type { Message } from '../../src/shared/domainTypes'
import { listPersistedTurns } from '../database'
import { cleanupOrphanProcess, type OrphanCleanupResult } from './orphanProcessCleanup'

export type StartupOrphanCleanupDeps = {
  listTurns: () => ReturnType<typeof listPersistedTurns>
  getMessage: (id: string) => Message | undefined
  cleanup?: (identity: { pid: number; processGroupId?: number; ownerToken: string }) => Promise<OrphanCleanupResult>
  audit?: (entry: { turnId: string; toolUseId: string; result: OrphanCleanupResult }) => void
}

export async function cleanupPersistedOrphansOnStartup(deps: StartupOrphanCleanupDeps): Promise<number> {
  const cleanup = deps.cleanup ?? cleanupOrphanProcess
  let count = 0
  for (const persisted of deps.listTurns()) {
    if (!['prepared', 'executing', 'waiting-confirm'].includes(persisted.state)) continue
    const assistant = deps.getMessage(persisted.assistantMessageId)
    for (const tool of assistant?.toolCalls ?? []) {
      if (tool.toolName !== 'run_shell' || tool.status !== 'executing' || !tool.processPid || !tool.processOwnerToken) continue
      const result = await cleanup({ pid: tool.processPid, processGroupId: tool.processGroupId, ownerToken: tool.processOwnerToken })
      deps.audit?.({ turnId: persisted.turnId, toolUseId: tool.id, result })
      count += 1
    }
  }
  return count
}
