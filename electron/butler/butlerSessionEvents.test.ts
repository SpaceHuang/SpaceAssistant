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

  async function makeBrokenSink(failClosedCriticalEvents: boolean) {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-session-events-'))
    roots.push(userDataDir)
    const taskId = `task-${roots.length}`
    const privateRoot = path.join(userDataDir, 'automation-sessions', taskId)
    await fs.mkdir(privateRoot, { recursive: true })
    await fs.writeFile(path.join(privateRoot, 'sessions'), 'not a directory')
    return createButlerSessionEvents({
      userDataDir, taskId, sessionId: `session-${roots.length}`, sessionCreatedAt: 1,
      failClosedCriticalEvents
    })
  }

  it('rejects Hosted critical ledger failures while keeping assistant chunks best effort', async () => {
    const events = await makeBrokenSink(true)
    await expect(events.emitSessionEvent({ type: 'tool_call', payload: { toolUseId: 'tool-1' } })).rejects.toThrow()
    await expect(events.emitSessionEvent({ type: 'assistant_chunk', payload: { delta: { type: 'text_delta', text: 'x' } } })).resolves.toBeUndefined()
    await events.sink.close().catch(() => undefined)
  })

  it('keeps legacy compatibility mode diagnostic-only for critical ledger failures', async () => {
    const events = await makeBrokenSink(false)
    await expect(events.emitSessionEvent({ type: 'tool_call', payload: { toolUseId: 'tool-1' } })).resolves.toBeUndefined()
    await events.sink.close().catch(() => undefined)
  })

  it('writes an event under the application private task directory, independent of task roots', async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-private-events-'))
    roots.push(userDataDir)
    const taskRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-authorized-root-'))
    roots.push(taskRoot)
    const events = await createButlerSessionEvents({ userDataDir, taskId: 'task-a', sessionId: 'session-a', sessionCreatedAt: 1 })
    await events.sink.appendCritical({ type: 'turn_start', payload: { turnId: 'turn-a' } })
    expect(events.sink.eventsPath).toContain(path.join('automation-sessions', 'task-a', 'sessions'))
    expect(events.sink.eventsPath).not.toContain(taskRoot)
    await events.sink.close()
  })
})
