import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { createTempDatabase } from './database/testHelpers';
import { getConfigValue, setConfigValue } from './database';
import { registerConfigIpc } from './ipc/configIpc';
import type { AppIpcContext } from './appIpc';
import {
  getLlmServiceApiKey,
  persistLlmServices,
  readLlmServices,
} from './llmServiceResolver';
import { decryptSecret } from './secureApiKey';
import { remoteAuthorizationRegistry } from './remote/remoteAuthorizationRegistry';
import { createRemoteAuthorizationEpochStore } from './remote/remoteAuthorizationEpochStore';
import { createDeferredTodoStore } from './confirmation/deferredTodoStore';
import { persistFeishuConfig } from './feishu/feishuIpc';

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  dialog: { showOpenDialog: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(() => []), setApplicationMenu: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));

vi.mock('./secureApiKey', () => ({
  encryptSecret: (plain: string) => `enc:${plain}`,
  decryptSecret: vi.fn((enc: string) => enc.replace(/^enc:/, '')),
  isSecretEncrypted: (value: string) => value.startsWith('enc:'),
  isLegacySecret: (value: string) => !value.startsWith('enc:'),
}));

function makeIpc() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    ),
    getHandler: (channel: string) => handlers.get(channel),
  };
}

function makeContext(db: AppIpcContext['db']): AppIpcContext {
  return {
    db,
    backup: {} as AppIpcContext['backup'],
    workDirManager: {
      listProfiles: () => [],
      addProfile: vi.fn(),
      updateProfile: vi.fn(),
      removeProfile: vi.fn(),
      switchProfile: vi.fn(),
      getActiveProfile: () => undefined,
      getActiveWorkDir: () => path.resolve('/tmp/spaceassistant-test-workdir'),
      getActiveProfileId: () => 'default',
      validateProfilesForSave: () => ({ valid: true }),
      validateProfileInput: () => ({ valid: true }),
      checkDirectoryWritable: () => ({ ok: true }),
      migrateFromLegacy: vi.fn(),
      persistProfiles: vi.fn(),
    } as unknown as AppIpcContext['workDirManager'],
    getWorkDir: () => path.resolve('/tmp/spaceassistant-test-workdir'),
    setWorkDir: vi.fn(),
    getUserDataPath: () => '/tmp/spaceassistant-test-userdata',
    getApiKey: vi.fn().mockResolvedValue(null),
    setApiKey: vi.fn(),
    getBrowserDetectContext: () => ({
      isPackaged: false,
      appPath: '/tmp',
      devRoot: '/tmp',
    }),
  };
}

describe('config:set API Key transaction boundary', () => {
  it('uses the 80% default and rejects out-of-range compaction thresholds before persisting', async () => {
    const temp = createTempDatabase('sa-config-compaction-threshold-')
    cleanup = temp.cleanup
    const ipc = makeIpc()
    registerConfigIpc(ipc as unknown as IpcMain, makeContext(temp.db))
    const read = ipc.getHandler('config:get')!
    const save = ipc.getHandler('config:set')!
    expect(await read()).toMatchObject({ contextCompactionTriggerRatio: 0.8 })
    for (const value of [0.55, 0.95]) {
      await expect(save({}, { contextCompactionTriggerRatio: value })).rejects.toThrow()
      expect(await read()).toMatchObject({ contextCompactionTriggerRatio: 0.8 })
    }
    await save({}, { contextCompactionTriggerRatio: 0.6 })
    expect(await read()).toMatchObject({ contextCompactionTriggerRatio: 0.6 })
  })

  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('keeps the old key and service metadata when a later model validation fails', async () => {
    const temp = createTempDatabase('sa-config-key-atomic-');
    cleanup = temp.cleanup;
    const db = temp.db;
    const serviceId = 'service-1';
    const oldModel = {
      id: 'old-model',
      name: 'old-model',
      maximumContext: 200000,
      maxTokens: 64000,
      isDefault: false,
      isFast: false,
      isVision: false,
      enabled: true,
    };
    setConfigValue(db, 'config.models', JSON.stringify([oldModel]));
    persistLlmServices(
      db,
      [
        {
          id: serviceId,
          name: 'Old name',
          baseUrl: '',
          apiKeyPresent: false,
          supportedModelIds: ['old-model'],
        },
      ],
      [serviceId],
      { [serviceId]: 'old-secret' },
    );
    vi.mocked(decryptSecret).mockImplementationOnce(() => {
      throw new Error('authorization denied');
    });
    await expect(getLlmServiceApiKey(db, serviceId)).rejects.toThrow('LLM_KEY_ACCESS_DENIED');
    vi.mocked(decryptSecret).mockClear();

    const ipc = makeIpc();
    registerConfigIpc(ipc as unknown as IpcMain, makeContext(db));
    const save = ipc.getHandler('config:set')!;

    await expect(
      save(
        {},
        {
          llmServices: [
            {
              id: serviceId,
              name: 'New name',
              baseUrl: '',
              apiKeyPresent: true,
              supportedModelIds: ['old-model'],
            },
          ],
          activeLlmServiceIds: [serviceId],
          llmServiceKeys: { [serviceId]: 'new-secret' },
          models: [],
        },
      ),
    ).rejects.toThrow('须至少支持一个模型');

    vi.mocked(decryptSecret).mockClear();
    await expect(getLlmServiceApiKey(db, serviceId)).rejects.toThrow(
      'LLM_KEY_ACCESS_DENIED',
    );
    expect(decryptSecret).not.toHaveBeenCalled();
    expect(readLlmServices(db)[0]?.name).toBe('Old name');
    expect(JSON.parse(getConfigValue(db, 'config.models') ?? '[]')).toEqual([
      oldModel,
    ]);
    const config = await ipc.getHandler('config:get')!() as Record<string, unknown>;
    expect(config).not.toHaveProperty('apiKeyAccessUpgradeNoticeRequired');
  });

  it('returns only the generic key access failure code when verification cannot decrypt a key', async () => {
    const temp = createTempDatabase('sa-config-key-verify-failure-');
    cleanup = temp.cleanup;
    const db = temp.db;
    const serviceId = 'service-verify-failure';
    persistLlmServices(db, [{ id: serviceId, name: 'Service', baseUrl: '', apiKeyPresent: false, supportedModelIds: ['model-1'] }], [serviceId], { [serviceId]: 'saved-secret' });
    vi.mocked(decryptSecret).mockImplementationOnce(() => { throw new Error('decrypt failed'); });

    const ipc = makeIpc();
    registerConfigIpc(ipc as unknown as IpcMain, makeContext(db));
    await expect(ipc.getHandler('config:verify-llm-key')!({}, serviceId)).resolves.toEqual({ ok: false, code: 'LLM_KEY_ACCESS_DENIED' });
  });

  it('invalidates both remote channels when a workdir profile boundary changes', async () => {
    const temp = createTempDatabase('sa-config-workdir-revoke-');
    cleanup = temp.cleanup;
    const db = temp.db;
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'p1', name: 'Project', path: '/project/a', isDefault: true, sensitive: false }]));
    setConfigValue(db, 'config.activeWorkDirProfileId', 'p1');
    const invalidate = vi.spyOn(remoteAuthorizationRegistry, 'invalidate');
    const ipc = makeIpc();
    registerConfigIpc(ipc as unknown as IpcMain, makeContext(db));
    await ipc.getHandler('config:set')!({}, {
      workDirProfiles: [{ id: 'p1', name: 'Project', path: '/project/private', isDefault: true, sensitive: true }],
      activeWorkDirProfileId: 'p1'
    });
    expect(invalidate).toHaveBeenCalledWith('feishu', 'workdir_changed');
    expect(invalidate).toHaveBeenCalledWith('wechat', 'workdir_changed');
    invalidate.mockRestore();
  });

  it('persists channel close and owner changes across re-enable with real todo storage', async () => {
    const temp = createTempDatabase('sa-config-channel-revocation-');
    cleanup = temp.cleanup;
    const db = temp.db;
    setConfigValue(db, 'config.feishu', JSON.stringify({ enabled: true, remoteEnabled: true, remoteSenderAllowlist: ['owner-a'] }));
    const epochStore = createRemoteAuthorizationEpochStore(db);
    remoteAuthorizationRegistry.bindPersistentEpochStore(epochStore);
    const todos = createDeferredTodoStore(db);
    const rule = { ruleId: 'write', factsHash: 'b'.repeat(64) };
    todos.create({ todoId: 'close-reenable-todo', channel: 'feishu', identityKey: 'identity-a', ownerId: 'owner-a', authorizationEpoch: 1,
      rule, invocationId: 'close-reenable-inv', workflowId: 'wf', taskId: 'task', stepId: 'step', planRevision: 1,
      originSessionId: 'origin', createdAt: 1, expiresAt: Date.now() + 60_000 });
    const unregister = remoteAuthorizationRegistry.registerDeferredTodoInvalidator({
      invalidateByAuthorizationEpoch: (channel, epoch) => { todos.invalidateOlderAuthorizationEpochs(channel, epoch); }
    }, 'config-ipc-real-todos');
    const ipc = makeIpc();
    registerConfigIpc(ipc as unknown as IpcMain, makeContext(db));
    const setConfig = ipc.getHandler('config:set')!;

    await setConfig({}, { feishu: { remoteEnabled: false } });
    expect(epochStore.current('feishu')).toBe(2);
    expect(todos.get('close-reenable-todo', { channel: 'feishu', identityKey: 'identity-a', ownerId: 'owner-a', authorizationEpoch: 1, originSessionId: 'origin', rule })?.status).toBe('invalidated');
    await setConfig({}, { feishu: { remoteEnabled: true } });
    expect(epochStore.current('feishu')).toBe(2);
    persistFeishuConfig(db, { remoteSenderAllowlist: ['owner-b'] });
    expect(epochStore.current('feishu')).toBe(3);
    expect(todos.claimForDispatch('close-reenable-todo', { channel: 'feishu', identityKey: 'identity-a', ownerId: 'owner-a', authorizationEpoch: 1, rule })).toBeNull();
    unregister();
  });

  it('does not let a stale global settings snapshot disable a newly bound WeChat owner', async () => {
    const temp = createTempDatabase('sa-config-wechat-runtime-state-');
    cleanup = temp.cleanup;
    const db = temp.db;
    setConfigValue(db, 'config.wechat', JSON.stringify({
      enabled: true,
      loggedIn: true,
      remoteEnabled: true,
      remoteSenderAllowlist: ['bound-owner@wechat'],
    }));
    const epochStore = createRemoteAuthorizationEpochStore(db);
    remoteAuthorizationRegistry.bindPersistentEpochStore(epochStore);
    const initialEpoch = epochStore.current('wechat');
    const ipc = makeIpc();
    registerConfigIpc(ipc as unknown as IpcMain, makeContext(db));

    await ipc.getHandler('config:set')!({}, {
      wechat: {
        enabled: false,
        loggedIn: false,
        remoteEnabled: false,
        remoteSenderAllowlist: [],
        remoteTypingEnabled: false,
      },
    });

    const stored = JSON.parse(getConfigValue(db, 'config.wechat')!) as Record<string, unknown>;
    expect(stored).toMatchObject({
      enabled: true,
      loggedIn: true,
      remoteEnabled: true,
      remoteSenderAllowlist: ['bound-owner@wechat'],
      remoteTypingEnabled: false,
    });
    expect(epochStore.current('wechat')).toBe(initialEpoch);
  });

  it('does not let a stale global settings snapshot erase the Feishu owner binding', async () => {
    const temp = createTempDatabase('sa-config-feishu-runtime-state-');
    cleanup = temp.cleanup;
    const db = temp.db;
    setConfigValue(db, 'config.feishu', JSON.stringify({
      enabled: true,
      appConfigured: true,
      userAuthorized: true,
      userDisplay: 'Owner',
      remoteEnabled: true,
      remoteSenderAllowlist: ['ou_bound-owner'],
    }));
    const epochStore = createRemoteAuthorizationEpochStore(db);
    remoteAuthorizationRegistry.bindPersistentEpochStore(epochStore);
    const initialEpoch = epochStore.current('feishu');
    const ipc = makeIpc();
    registerConfigIpc(ipc as unknown as IpcMain, makeContext(db));

    await ipc.getHandler('config:set')!({}, {
      feishu: {
        enabled: true,
        appConfigured: true,
        userAuthorized: true,
        userDisplay: 'Owner',
        remoteEnabled: true,
        remoteSenderAllowlist: [],
        remoteProgressMode: 'summary',
      },
    });

    const stored = JSON.parse(getConfigValue(db, 'config.feishu')!) as Record<string, unknown>;
    expect(stored).toMatchObject({
      enabled: true,
      appConfigured: true,
      userAuthorized: true,
      userDisplay: 'Owner',
      remoteEnabled: true,
      remoteSenderAllowlist: ['ou_bound-owner'],
      remoteProgressMode: 'summary',
    });
    expect(epochStore.current('feishu')).toBe(initialEpoch);
  });
});
