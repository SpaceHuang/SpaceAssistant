import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type AppDatabase } from '../database'
import { createAutomationTask, getAutomationTask } from './taskStore'
import { registerButlerIpcHandlers } from './butlerIpc'

const electronMock = vi.hoisted(() => ({
  canceled: false,
  filePaths: ['/tmp/chosen-task-root']
}))
vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: electronMock.canceled, filePaths: electronMock.filePaths })) },
  BrowserWindow: { getFocusedWindow: vi.fn(() => undefined) },
  ipcMain: { handle: vi.fn() }
}))

describe('butler IPC workdir/config fields', () => {
  let db: AppDatabase | undefined
  afterEach(() => { db?.close(); db = undefined })

  function handlers() {
    db = openDatabase(':memory:')
    const map = new Map<string, (...args: unknown[]) => unknown>()
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => map.set(channel, handler) } as never, {
      db,
      getWorkDir: () => '/tmp',
      getUserDataPath: () => '/tmp',
      getToolsConfig: () => ({}) as never
    } as never)
    return map
  }

  it('directory picker reports cancellation without a path and selected paths are validated', async () => {
    const map = handlers()
    electronMock.canceled = true
    await expect(map.get('butler:choose-workdir')!()).resolves.toEqual({ cancelled: true })
    electronMock.canceled = false
    electronMock.filePaths = ['/tmp']
    await expect(map.get('butler:choose-workdir')!()).resolves.toMatchObject({ cancelled: false, path: '/private/tmp' })
  })

  it('cannot create without explicit validated workdir and stable model/service pair', async () => {
    const map = handlers()
    const response = await map.get('butler:create')!(null, {
      name: 'task', prompt: 'report', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop'
    }) as { ok: boolean; error?: string }
    expect(response).toMatchObject({ ok: false, error: '任务工作目录不能为空' })
  })

  it('legacy directory-only edit sets its explicit path while leaving legacy model and effort NULL', async () => {
    const map = handlers()
    const legacy = createAutomationTask(db!, { name: 'legacy', prompt: 'report', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', modelOverride: 'old-provider-name' })
    const response = await map.get('butler:update')!(null, { id: legacy.id, patch: { workDir: '/tmp' } }) as { ok: boolean; error?: string }
    expect(response).toEqual({ ok: true })
    expect(getAutomationTask(db!, legacy.id)).toMatchObject({ workDir: '/private/tmp', modelOverride: 'old-provider-name' })
    expect(getAutomationTask(db!, legacy.id)).not.toHaveProperty('modelId')
    expect(getAutomationTask(db!, legacy.id)).not.toHaveProperty('reasoningEffort')
  })

  it('legacy task fields can be edited without submitting new config and keep NULL compatibility columns', async () => {
    const map = handlers()
    const legacy = createAutomationTask(db!, { name: 'legacy', prompt: 'old prompt', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', modelOverride: 'old-provider-name' })
    const response = await map.get('butler:update')!(null, { id: legacy.id, patch: { name: 'renamed', prompt: 'new prompt', schedule: { kind: 'interval', intervalMinutes: 45 } } }) as { ok: boolean; error?: string }
    expect(response).toEqual({ ok: true })
    expect(getAutomationTask(db!, legacy.id)).toMatchObject({ name: 'renamed', prompt: 'new prompt', schedule: { kind: 'interval', intervalMinutes: 45 }, modelOverride: 'old-provider-name' })
    expect(getAutomationTask(db!, legacy.id)).not.toHaveProperty('workDir')
    expect(getAutomationTask(db!, legacy.id)).not.toHaveProperty('modelId')
    expect(getAutomationTask(db!, legacy.id)).not.toHaveProperty('modelServiceId')
    expect(getAutomationTask(db!, legacy.id)).not.toHaveProperty('reasoningEffort')
  })
})
