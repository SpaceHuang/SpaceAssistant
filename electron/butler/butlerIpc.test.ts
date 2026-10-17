import { afterEach, describe, expect, it, vi } from 'vitest'
import { realpath } from 'node:fs/promises'
import os from 'node:os'
import { openDatabase, type AppDatabase } from '../database'
import { setConfigValue } from '../database'
import { claimDueSlotAndAdvance, createAutomationTask, getAutomationTask, transitionClaimToRunning } from './taskStore'
import { registerButlerIpcHandlers } from './butlerIpc'

const electronMock = vi.hoisted(() => ({
  canceled: false,
  filePaths: [] as string[]
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
      getWorkDir: () => os.tmpdir(),
      getUserDataPath: () => os.tmpdir(),
      getToolsConfig: () => ({}) as never
    } as never)
    return map
  }

  it('directory picker reports cancellation without a path and selected paths are validated', async () => {
    const map = handlers()
    electronMock.canceled = true
    await expect(map.get('butler:choose-workdir')!()).resolves.toEqual({ cancelled: true })
    electronMock.canceled = false
    electronMock.filePaths = [os.tmpdir()]
    await expect(map.get('butler:choose-workdir')!()).resolves.toMatchObject({ cancelled: false, path: await realpath(os.tmpdir()) })
  })

  it('defaults reasoning effort to off when the configured default model does not support Thinking', async () => {
    const map = handlers()
    setConfigValue(db!, 'config.models', JSON.stringify([{ id: 'model-1', name: 'provider-model', enabled: true, supportsThinking: false }]))
    setConfigValue(db!, 'config.defaultModel', 'provider-model')
    setConfigValue(db!, 'config.thinkingEffort', 'high')
    setConfigValue(db!, 'config.llmServices', JSON.stringify([{ id: 'service-1', name: 'Service', provider: 'openai', supportedModelIds: ['model-1'] }]))
    setConfigValue(db!, 'config.activeLlmServiceIds', JSON.stringify(['service-1']))
    setConfigValue(db!, 'secrets.llmServiceKeys', JSON.stringify({ 'service-1': 'present' }))
    expect(map.get('butler:get-defaults')!()).toMatchObject({ modelId: 'model-1', modelServiceId: 'service-1', reasoningEffort: 'off' })
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
    const response = await map.get('butler:update')!(null, { id: legacy.id, patch: { workDir: os.tmpdir() } }) as { ok: boolean; error?: string }
    expect(response).toEqual({ ok: true })
    expect(getAutomationTask(db!, legacy.id)).toMatchObject({ workDir: await realpath(os.tmpdir()), modelOverride: 'old-provider-name' })
    expect(getAutomationTask(db!, legacy.id)).not.toHaveProperty('modelId')
    expect(getAutomationTask(db!, legacy.id)).not.toHaveProperty('reasoningEffort')
  })

  it('returns stable conflicts for schedule edits and deletion while a run is active', async () => {
    const map = handlers()
    const task = createAutomationTask(db!, { name: 'scheduled', prompt: 'report', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', workDir: os.tmpdir(), nextRunAt: 100 })
    const claim = claimDueSlotAndAdvance(db!, { taskId: task.id, slot: 100, nextSlot: 200, clientId: 'ipc-pending-conflict' })
    expect(await map.get('butler:update')!(null, { id: task.id, patch: { schedule: { kind: 'daily', time: '10:00' } } })).toEqual({ ok: false, error: 'schedule-pending' })
    expect(await map.get('butler:delete')!(null, { id: task.id })).toEqual({ ok: false, error: 'task-has-active-run' })
    expect(transitionClaimToRunning(db!, claim.runId!, task.id, 100, 0).ok).toBe(true)
    expect(await map.get('butler:update')!(null, { id: task.id, patch: { schedule: { kind: 'daily', time: '10:00' } } })).toEqual({ ok: true })
  })

  it('updates a task with validated canonical multiple roots', async () => {
    const map = handlers()
    const legacy = createAutomationTask(db!, { name: 'legacy', prompt: 'report', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', workDir: os.tmpdir() })
    const child = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(`${os.tmpdir()}/butler-roots-`))
    try {
      const response = await map.get('butler:update')!(null, { id: legacy.id, patch: { workDirs: [child, os.tmpdir(), child] } }) as { ok: boolean; error?: string }
      expect(response).toEqual({ ok: true })
      expect(getAutomationTask(db!, legacy.id)?.workDirs).toEqual([await realpath(child), await realpath(os.tmpdir())].sort())
    } finally {
      await import('node:fs/promises').then(({ rm }) => rm(child, { recursive: true, force: true }))
    }
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
