import { randomUUID } from 'node:crypto'
import type { RuntimeTriggerTargetDto } from '../../src/shared/domainTypes'

export type ManagedProcessHandle = Readonly<{ managedProcessId: string; runtimeGeneration: string }>
export type ManagedProcessExitFact = Readonly<{ ok: true; managedProcessId: string; runtimeGeneration: string; sessionId: string; toolName: string; occurredAt: number; exitCode: number | null; signal: string | null; reason: string; outputRef?: Readonly<{ bytes: number; truncated: boolean; sha256?: string }> }>
export type ManagedProcessExit = Readonly<{ kind: 'running' }> | (ManagedProcessExitFact & Readonly<{ kind: 'terminal' }>) |
  Readonly<{ kind: 'source-gap'; code: 'TRIGGER_SOURCE_GAP'; case: 'managed-process-unavailable' | 'runtime-generation-mismatch' }>
type RunningProcess = { handle: ManagedProcessHandle; sessionId: string; toolName: string; state: 'running' | 'settled'; exit?: ManagedProcessExitFact }
type ProcessExitListener = (exit: ManagedProcessExitFact) => void

let generation = randomUUID()
const processes = new Map<string, RunningProcess>()
const listeners = new Set<ProcessExitListener>()
const MAX_RETAINED_EXIT_FACTS = 512
const gap = (caseId: Extract<ManagedProcessExit, { kind: 'source-gap' }>['case']): ManagedProcessExit => ({ kind: 'source-gap', code: 'TRIGGER_SOURCE_GAP', case: caseId })

export function managedProcessRuntimeGeneration(): string { return generation }

export function beginManagedProcess(input: { sessionId: string; toolName: string }): ManagedProcessHandle {
  if (!input.sessionId.trim() || !input.toolName.trim()) throw new TypeError('managed process identity required')
  const handle = Object.freeze({ managedProcessId: `mp_${randomUUID()}`, runtimeGeneration: generation })
  processes.set(handle.managedProcessId, { handle, sessionId: input.sessionId, toolName: input.toolName, state: 'running' })
  return handle
}

export function finishManagedProcess(handle: ManagedProcessHandle, result: { exitCode: number | null; signal: string | null; reason: string; outputRef?: { bytes: number; truncated: boolean; sha256?: string }; occurredAt?: number }): boolean {
  const current = processes.get(handle?.managedProcessId)
  if (!current || current.handle.runtimeGeneration !== handle.runtimeGeneration || current.state !== 'running') return false
  if ((result.exitCode !== null && !Number.isSafeInteger(result.exitCode)) || (result.signal !== null && typeof result.signal !== 'string') || !result.reason.trim() ||
    (result.outputRef && (!Number.isSafeInteger(result.outputRef.bytes) || result.outputRef.bytes < 0 || typeof result.outputRef.truncated !== 'boolean'))) return false
  const exit = Object.freeze({ ok: true as const, managedProcessId: handle.managedProcessId, runtimeGeneration: handle.runtimeGeneration,
    sessionId: current.sessionId, toolName: current.toolName, occurredAt: result.occurredAt ?? Date.now(), exitCode: result.exitCode,
    signal: result.signal, reason: result.reason, ...(result.outputRef ? { outputRef: Object.freeze({ ...result.outputRef }) } : {}) })
  current.state = 'settled'
  current.exit = exit
  let retained = [...processes.values()].filter((item) => item.state === 'settled').length
  while (retained > MAX_RETAINED_EXIT_FACTS) {
    const oldest = [...processes.entries()].find(([, item]) => item.state === 'settled')
    if (!oldest) break
    processes.delete(oldest[0])
    retained -= 1
  }
  for (const listener of listeners) { try { listener(exit) } catch { /* listeners cannot affect executor settlement */ } }
  return true
}

export function readManagedProcessExit(managedProcessId: string, runtimeGeneration: string): ManagedProcessExit {
  const current = processes.get(managedProcessId)
  if (!current) return gap('managed-process-unavailable')
  if (current.handle.runtimeGeneration !== runtimeGeneration || runtimeGeneration !== generation) return gap('runtime-generation-mismatch')
  if (current.state === 'running') return { kind: 'running' }
  return current.exit ? { ...current.exit, kind: 'terminal' } : gap('managed-process-unavailable')
}

export function listManagedProcessTargets(sessionId: string): RuntimeTriggerTargetDto[] {
  return [...processes.values()].filter((item) => item.sessionId === sessionId && item.state === 'running')
    .map((item) => ({ kind: 'managed-process', id: item.handle.managedProcessId, label: item.toolName, status: 'running' }))
}

export function subscribeManagedProcessExit(listener: ProcessExitListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function resetManagedProcessSourceForTests(): void { processes.clear(); listeners.clear(); generation = randomUUID() }
