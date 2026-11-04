import type { SessionCommands } from '../sessionStorage/public/ports'
import type { RuntimeTriggerRecord, RuntimeTriggerPatch } from '../sessionStorage/public/model'
import { parseRuntimeTriggerDefinition } from './protocol'

export type RuntimeTriggerStoredRecord = RuntimeTriggerRecord
export type RuntimeTriggerStorePatch = RuntimeTriggerPatch
function validateRecord(record: RuntimeTriggerStoredRecord | null): RuntimeTriggerStoredRecord | null {
  if (!record) return null
  return { ...record, definition: parseRuntimeTriggerDefinition(record.definition) }
}
export const readRuntimeTrigger = (commands: SessionCommands, triggerId: string) => validateRecord(commands.runtimeTriggers.read(triggerId))
export const findRuntimeTriggerByClientKey = (commands: SessionCommands, ownerSessionId: string, clientKey: string) => validateRecord(commands.runtimeTriggers.findByClientKey(ownerSessionId, clientKey))
export const insertRuntimeTrigger = (commands: SessionCommands, input: RuntimeTriggerStoredRecord, validateAtCommit?: () => boolean) => validateRecord(commands.runtimeTriggers.insert({ ...input, definition: parseRuntimeTriggerDefinition(input.definition) }, validateAtCommit))!
export const updateRuntimeTrigger = (commands: SessionCommands, triggerId: string, expectedRevision: number, patch: RuntimeTriggerStorePatch) => validateRecord(commands.runtimeTriggers.update(triggerId, expectedRevision, patch))
