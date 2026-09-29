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
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'butler-session-events-'))
    roots.push(workDir)
    await fs.writeFile(path.join(workDir, 'sessions'), 'not a directory')
    return createButlerSessionEvents({
      workDir, sessionId: `session-${roots.length}`, sessionCreatedAt: 1,
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
})
