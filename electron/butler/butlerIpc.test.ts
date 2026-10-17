import { afterEach, describe, expect, it, vi } from 'vitest'
import { realpath } from 'node:fs/promises'
import os from 'node:os'
import { openDatabase, type AppDatabase } from '../database'
import { setConfigValue } from '../database'
import { claimDueSlotAndAdvance, createAutomationTask, getAutomationTask, transitionClaimToRunning, updateAutomationTask } from './taskStore'
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
    } as never, {
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'model-1', modelServiceId: 'service-1', modelOverride: 'provider-model', reasoningEffort: 'off' as const })),
      createAnalyzer: () => ({ analyze: vi.fn(async () => ({ targets: [{ kind: 'exact', path: os.tmpdir(), targetType: 'directory' }] })) }),
      preflight: vi.fn(async (input) => ({ report: { status: 'passed', blockers: [], suggestedDirectories: [] }, bindings: [{ kind: 'exact', path: input.roots[0]!, targetType: 'directory', rawText: input.prompt, resolverVersion: 1, rootsDigest: 'test', taskRevision: input.taskRevision }] }))
    })
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
    expect(map.get('butler:get-defaults')!()).not.toHaveProperty('workDir')
  })

  it('legacy single-root update payload is normalized to workDirs', async () => {
    const map = handlers()
    const legacy = createAutomationTask(db!, { name: 'legacy', prompt: 'report', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop' })
    const response = await map.get('butler:update')!(null, { id: legacy.id, patch: { workDir: os.tmpdir() } }) as { ok: boolean; error?: string }
    expect(response).toMatchObject({ ok: true })
    expect(getAutomationTask(db!, legacy.id)?.workDirs).toEqual([await realpath(os.tmpdir())])
  })

  it('cannot create without explicit validated workdir and stable model/service pair', async () => {
    const map = handlers()
    const response = await map.get('butler:create')!(null, {
      name: 'task', prompt: 'report', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop'
    }) as { ok: boolean; error?: string }
    expect(response).toMatchObject({ ok: false, error: '任务工作目录不能为空' })
  })

  it('blocks a valid create with a structured report and writes no task', async () => {
    const map = handlers()
    const blockedPreflight = vi.fn(async () => ({ report: { status: 'blocked' as const, blockers: [{ code: 'TARGET_AMBIGUOUS', messageKey: 'butler.preflight.target_ambiguous' }], suggestedDirectories: [] }, bindings: [] }))
    const fresh = openDatabase(':memory:')
    db?.close()
    db = fresh
    const mapBlocked = new Map<string, (...args: unknown[]) => unknown>()
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => mapBlocked.set(channel, handler) } as never, { db, getWorkDir: () => os.tmpdir(), getUserDataPath: () => os.tmpdir(), getToolsConfig: () => ({}) as never } as never, {
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'model-1', modelServiceId: 'service-1', modelOverride: 'provider-model', reasoningEffort: 'off' as const })),
      preflight: blockedPreflight
    })
    const before = mapBlocked.get('butler:list')!() as unknown[]
    const response = await mapBlocked.get('butler:create')!(null, { name: 'blocked', prompt: 'report.csv', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', workDirs: [os.tmpdir()], modelId: 'model-1', modelServiceId: 'service-1', modelOverride: 'provider-model', reasoningEffort: 'off' })
    expect(response).toMatchObject({ ok: false, kind: 'preflight-blocked', report: { status: 'blocked', blockers: [{ code: 'TARGET_AMBIGUOUS' }] } })
    expect(mapBlocked.get('butler:list')!()).toEqual(before)
    expect(blockedPreflight).toHaveBeenCalledOnce()
  })

  it('commits passed preflight bindings with the created task', async () => {
    const map = handlers()
    setConfigValue(db!, 'config.models', JSON.stringify([{ id: 'model-1', name: 'provider-model', enabled: true }]))
    setConfigValue(db!, 'config.llmServices', JSON.stringify([{ id: 'service-1', name: 'Service', provider: 'openai', supportedModelIds: ['model-1'] }]))
    setConfigValue(db!, 'config.activeLlmServiceIds', JSON.stringify(['service-1']))
    setConfigValue(db!, 'secrets.llmServiceKeys', JSON.stringify({ 'service-1': 'present' }))
    const response = await map.get('butler:create')!(null, {
      name: 'preflighted', prompt: 'report.csv', schedule: { kind: 'interval', intervalMinutes: 30 },
      deliveryPref: 'desktop', workDirs: [os.tmpdir()], modelId: 'model-1', modelServiceId: 'service-1',
      modelOverride: 'provider-model', reasoningEffort: 'off'
    }) as { ok: boolean; id?: string; task?: { preflightVersion: number; targetBindingsJson?: string | null } }
    expect(response).toMatchObject({ ok: true, task: { preflightVersion: 1 } })
    const bindingPath = await realpath(os.tmpdir())
    expect(JSON.parse(response.task?.targetBindingsJson ?? '[]')).toMatchObject([{ path: bindingPath, kind: 'exact' }])
    const stored = getAutomationTask(db!, response.id!)
    expect(stored?.preflightVersion).toBe(1)
    expect(JSON.parse(stored?.targetBindingsJson ?? '[]')).toMatchObject([{ path: bindingPath, kind: 'exact' }])
  })

  it('does not create or update a task when model preflight is unavailable', async () => {
    const d = openDatabase(':memory:')
    db = d
    const legacy = createAutomationTask(d, { name: 'legacy', prompt: 'report.csv', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', workDirs: [os.tmpdir()] })
    const map = new Map<string, (...args: unknown[]) => unknown>()
    const preflight = vi.fn(async () => ({ report: { status: 'unavailable' as const, blockers: [{ code: 'MODEL_UNAVAILABLE', messageKey: 'butler.preflight.unavailable' }], suggestedDirectories: [] }, bindings: [] }))
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => map.set(channel, handler) } as never, { db: d } as never, {
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' as const })),
      preflight
    })
    const before = map.get('butler:list')!()
    const payload = { name: 'new', prompt: 'report.csv', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', workDirs: [os.tmpdir()], modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' }
    expect(await map.get('butler:create')!(null, payload)).toMatchObject({ ok: false, kind: 'preflight-unavailable', error: 'MODEL_UNAVAILABLE' })
    expect(await map.get('butler:update')!(null, { id: legacy.id, patch: { prompt: 'new.csv' } })).toMatchObject({ ok: false, kind: 'preflight-unavailable' })
    expect(map.get('butler:list')!()).toEqual(before)
    expect(getAutomationTask(d, legacy.id)).toMatchObject({ prompt: 'report.csv', preflightVersion: 0 })
    expect(preflight).toHaveBeenCalledTimes(2)
  })

  it('uses the handler entry time for once schedules and blocks an already due value', async () => {
    const d = openDatabase(':memory:')
    db = d
    const map = new Map<string, (...args: unknown[]) => unknown>()
    const preflight = vi.fn(async () => ({ report: { status: 'passed' as const, blockers: [], suggestedDirectories: [] }, bindings: [] }))
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => map.set(channel, handler) } as never, { db: d } as never, {
      now: () => 50_000,
      validateWorkDirs: vi.fn(async (roots) => ({ ok: true as const, workDirs: roots as string[] })),
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' as const })),
      preflight
    })
    const response = await map.get('butler:create')!(null, { name: 'once', prompt: 'report', schedule: { kind: 'once', at: 50_000 }, deliveryPref: 'desktop', workDirs: ['/workspace'], modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' })
    expect(response).toMatchObject({ ok: false, kind: 'preflight-blocked', report: { blockers: [{ code: 'ONCE_AT_NOT_FUTURE' }] } })
    expect(preflight).not.toHaveBeenCalled()
    expect(map.get('butler:list')!()).toEqual([])
  })

  it('does not commit a preflight result when the task revision changes while analysis is pending', async () => {
    const d = openDatabase(':memory:')
    db = d
    const legacy = createAutomationTask(d, { name: 'stale', prompt: 'old', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', workDirs: [os.tmpdir()] })
    const map = new Map<string, (...args: unknown[]) => unknown>()
    let release!: (result: { report: { status: 'passed'; blockers: []; suggestedDirectories: [] }; bindings: [] }) => void
    const preflight = vi.fn(() => new Promise<{ report: { status: 'passed'; blockers: []; suggestedDirectories: [] }; bindings: [] }>((resolve) => { release = resolve }))
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => map.set(channel, handler) } as never, { db: d } as never, {
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' as const })),
      preflight
    })
    const pending = map.get('butler:update')!(null, { id: legacy.id, patch: { expectedTaskRevision: legacy.taskRevision, name: 'stale write' } }) as Promise<unknown>
    await vi.waitFor(() => expect(preflight).toHaveBeenCalled())
    updateAutomationTask(d, legacy.id, { prompt: 'concurrent write' })
    release({ report: { status: 'passed', blockers: [], suggestedDirectories: [] }, bindings: [] })
    expect(await pending).toMatchObject({ ok: false, kind: 'validation-error', error: 'task-revision-conflict' })
    expect(getAutomationTask(d, legacy.id)).toMatchObject({ name: 'stale', prompt: 'concurrent write', preflightVersion: 0 })
  })

  it('legacy directory-only edit sets its explicit path while leaving legacy model and effort NULL', async () => {
    const map = handlers()
    const legacy = createAutomationTask(db!, { name: 'legacy', prompt: 'report', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', modelOverride: 'old-provider-name' })
    const response = await map.get('butler:update')!(null, { id: legacy.id, patch: { workDir: os.tmpdir() } }) as { ok: boolean; error?: string }
    expect(response).toMatchObject({ ok: true })
    expect(getAutomationTask(db!, legacy.id)).toMatchObject({ workDir: await realpath(os.tmpdir()), modelOverride: 'old-provider-name' })
    expect(getAutomationTask(db!, legacy.id)).not.toHaveProperty('modelId')
    expect(getAutomationTask(db!, legacy.id)).not.toHaveProperty('reasoningEffort')
  })

  it('returns stable conflicts for schedule edits and deletion while a run is active', async () => {
    const map = handlers()
    const task = createAutomationTask(db!, { name: 'scheduled', prompt: 'report', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', workDir: os.tmpdir(), nextRunAt: 100 })
    const claim = claimDueSlotAndAdvance(db!, { taskId: task.id, slot: 100, nextSlot: 200, clientId: 'ipc-pending-conflict' })
    expect(await map.get('butler:update')!(null, { id: task.id, patch: { schedule: { kind: 'daily', time: '10:00' } } })).toMatchObject({ ok: false, kind: 'validation-error', error: 'schedule-pending' })
    expect(await map.get('butler:delete')!(null, { id: task.id })).toEqual({ ok: false, error: 'task-has-active-run' })
    expect(transitionClaimToRunning(db!, claim.runId!, task.id, 100, 0).ok).toBe(true)
    expect(await map.get('butler:update')!(null, { id: task.id, patch: { schedule: { kind: 'daily', time: '10:00' } } })).toMatchObject({ ok: true })
  })

  it('updates a task with validated canonical multiple roots', async () => {
    const map = handlers()
    const legacy = createAutomationTask(db!, { name: 'legacy', prompt: 'report', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', workDir: os.tmpdir() })
    const child = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(`${os.tmpdir()}/butler-roots-`))
    try {
      const response = await map.get('butler:update')!(null, { id: legacy.id, patch: { workDirs: [child, os.tmpdir(), child] } }) as { ok: boolean; error?: string }
      expect(response).toMatchObject({ ok: true })
      expect(getAutomationTask(db!, legacy.id)?.workDirs).toEqual([await realpath(child), await realpath(os.tmpdir())].sort())
    } finally {
      await import('node:fs/promises').then(({ rm }) => rm(child, { recursive: true, force: true }))
    }
  })

  it('legacy task fields can be edited without submitting new config and keep NULL compatibility columns', async () => {
    const map = handlers()
    const legacy = createAutomationTask(db!, { name: 'legacy', prompt: 'old prompt', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', modelOverride: 'old-provider-name' })
    const response = await map.get('butler:update')!(null, { id: legacy.id, patch: { name: 'renamed', prompt: 'new prompt', schedule: { kind: 'interval', intervalMinutes: 45 } } }) as { ok: boolean; error?: string }
    expect(response).toMatchObject({ ok: true })
    expect(getAutomationTask(db!, legacy.id)).toMatchObject({ name: 'renamed', prompt: 'new prompt', schedule: { kind: 'interval', intervalMinutes: 45 }, modelOverride: 'old-provider-name' })
    expect(getAutomationTask(db!, legacy.id)).not.toHaveProperty('workDir')
    expect(getAutomationTask(db!, legacy.id)).not.toHaveProperty('modelId')
    expect(getAutomationTask(db!, legacy.id)).not.toHaveProperty('modelServiceId')
    expect(getAutomationTask(db!, legacy.id)).not.toHaveProperty('reasoningEffort')
  })
})
