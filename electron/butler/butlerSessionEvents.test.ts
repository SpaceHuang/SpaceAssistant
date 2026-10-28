import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createButlerSessionEvents } from './butlerSessionEvents'

describe('createButlerSessionEvents', () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  })

  const unusedStorage = { queries: { readMessage: () => undefined }, commands: { updateStreamingMessage: () => null } } as unknown as import('../sessionStorage/host/ports').SessionStorage

  async function makeBrokenSink(failClosedCriticalEvents: boolean) {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-session-events-'))
    roots.push(userDataDir)
    const taskId = `task-${roots.length}`
    const privateRoot = path.join(userDataDir, 'automation-sessions', taskId)
    await fs.mkdir(privateRoot, { recursive: true })
    await fs.writeFile(path.join(privateRoot, 'sessions'), 'not a directory')
    return createButlerSessionEvents({
      userDataDir, taskId, sessionId: `session-${roots.length}`, sessionCreatedAt: 1,
      assistantMessageId: 'assistant-test', sessionStorage: unusedStorage,
      failClosedCriticalEvents
    })
  }

  it('rejects Hosted critical ledger failures while keeping assistant chunks best effort', async () => {
    const events = await makeBrokenSink(true)
    await expect(events.emitSessionEvent({ type: 'tool_call', payload: { toolUseId: 'tool-1' } })).rejects.toThrow()
    await expect(events.emitSessionEvent({ type: 'assistant_chunk', payload: { delta: { type: 'text_delta', text: 'x' } } })).resolves.toBeUndefined()
    await events.sink?.close().catch(() => undefined)
  })

  it('keeps legacy compatibility mode diagnostic-only for critical ledger failures', async () => {
    const events = await makeBrokenSink(false)
    await expect(events.emitSessionEvent({ type: 'tool_call', payload: { toolUseId: 'tool-1' } })).resolves.toBeUndefined()
    await events.sink?.close().catch(() => undefined)
  })

  it('keeps the event facade usable when ledger initialization is unavailable', async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-session-events-init-failure-'))
    roots.push(userDataDir)
    await fs.writeFile(path.join(userDataDir, 'automation-sessions'), 'not a directory')
    const events = await createButlerSessionEvents({ userDataDir, taskId: 'task-init-failure', sessionId: 'session-init-failure',
      sessionCreatedAt: 1, assistantMessageId: 'assistant-test', sessionStorage: unusedStorage, failClosedCriticalEvents: false })
    expect(events.sink).toBeUndefined()
    await expect(events.emitSessionEvent({ type: 'turn_start', payload: { turnId: 'turn-init-failure' } })).resolves.toBeUndefined()
  })

  it('omits the secondary ledger when canonical readiness is false', async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-session-events-disabled-'))
    roots.push(userDataDir)
    const events = await createButlerSessionEvents({ userDataDir, taskId: 'task-disabled', sessionId: 'session-disabled',
      sessionCreatedAt: 1, assistantMessageId: 'assistant-test', sessionStorage: unusedStorage, enableLedger: false })
    expect(events.sink).toBeUndefined()
    expect(await fs.stat(path.join(userDataDir, 'automation-sessions')).catch(() => undefined)).toBeUndefined()
    await expect(events.emitSessionEvent({ type: 'turn_start', payload: { turnId: 'turn-disabled' } })).resolves.toBeUndefined()
  })

  it('writes an event under the application private task directory, independent of task roots', async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-private-events-'))
    roots.push(userDataDir)
    const taskRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-authorized-root-'))
    roots.push(taskRoot)
    const events = await createButlerSessionEvents({ userDataDir, taskId: 'task-a', sessionId: 'session-a', sessionCreatedAt: 1,
      assistantMessageId: 'assistant-test', sessionStorage: unusedStorage })
    await events.sink!.appendCritical({ type: 'turn_start', payload: { turnId: 'turn-a' } })
    expect(events.sink.eventsPath).toContain(path.join('automation-sessions', 'task-a', 'sessions'))
    expect(events.sink.eventsPath).not.toContain(taskRoot)
    await events.sink?.close()
  })

  it('persists tool and approval facts into the automation assistant message ledger', async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-message-facts-'))
    roots.push(userDataDir)
    let message = { id: 'assistant-a', sessionId: 'session-a', role: 'assistant' as const, content: '', timestamp: 1, status: 'streaming' as const, schemaVersion: 1 }
    const writes: unknown[] = []
    const sessionStorage = {
      queries: { readMessage: () => message },
      commands: { updateStreamingMessage: (_id: string, next: typeof message) => { message = next; writes.push(next); return { message: next, sequence: 1 } } }
    } as unknown as import('../sessionStorage/host/ports').SessionStorage
    const events = await createButlerSessionEvents({ userDataDir, taskId: 'task-a', sessionId: 'session-a', sessionCreatedAt: 1, assistantMessageId: 'assistant-a', sessionStorage })
    events.emitFactEvent({ type: 'content-delta', text: '正文' })
    events.emitFactEvent({ type: 'thinking-delta', text: '推理' })
    events.emitFactEvent({ type: 'tool-use', id: 'tool-a', toolName: 'write_file', input: { path: 'a' } })
    events.emitFactEvent({ type: 'confirm-requested', id: 'tool-a', riskLevel: 'high', lane: 'automation' })
    events.emitFactEvent({ type: 'tool-result', id: 'tool-a', result: { success: false, error: 'denied', notExecutedReason: 'policy_denied' } })
    events.emitFactEvent({ type: 'skill-hint', text: '已使用技能' })
    expect(message).toMatchObject({ content: '正文', contentSegments: [{ content: '正文' }], thinking: { content: '推理' },
      toolCalls: [{ id: 'tool-a', status: 'failed', riskLevel: 'high', result: { notExecutedReason: 'policy_denied' } }],
      skillHints: [{ text: '已使用技能' }] })
    expect(writes).toHaveLength(6)
    await events.sink?.close()
  })
})
