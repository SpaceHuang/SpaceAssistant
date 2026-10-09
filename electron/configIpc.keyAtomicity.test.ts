import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  dialog: { showOpenDialog: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(() => []), setApplicationMenu: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));

vi.mock('./secureApiKey', () => ({
  isSecretStorageAvailable: () => true,
  encryptSecret: (plain: string) => `enc:${plain}`,
  decryptSecret: vi.fn((enc: string) => enc.replace(/^enc:/, '')),
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
  let cleanup: (() => void) | undefined;
  // config:get 的 apiKeyAccessUpgradeNoticeRequired 带 process.platform === 'darwin' 守卫，
  // 断言与运行平台无关，统一 stub 为 darwin（沿用 bashPathFork.test.ts 的恢复式写法）。
  const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform');

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  afterEach(() => {
    if (platformDesc) Object.defineProperty(process, 'platform', platformDesc);
    cleanup?.();
    cleanup = undefined;
  });

  it('announces an app-version change once when a saved API Key exists', async () => {
    const temp = createTempDatabase('sa-config-key-upgrade-notice-');
    cleanup = temp.cleanup;
    const db = temp.db;
    const serviceId = 'service-1';
    persistLlmServices(
      db,
      [{ id: serviceId, name: 'Service', baseUrl: '', apiKeyPresent: false, supportedModelIds: ['model-1'] }],
      [serviceId],
      { [serviceId]: 'saved-secret' },
    );

    const ipc = makeIpc();
    registerConfigIpc(ipc as unknown as IpcMain, makeContext(db));
    const getConfig = ipc.getHandler('config:get')!;

    const upgradedConfig = await getConfig();
    expect(upgradedConfig).toMatchObject({ apiKeyAccessUpgradeNoticeRequired: true });
    await ipc.getHandler('config:ack-key-access-upgrade-notice')!();
    const sameVersionConfig = await getConfig();
    expect(sameVersionConfig).toMatchObject({ apiKeyAccessUpgradeNoticeRequired: false });
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
    await expect(getLlmServiceApiKey(db, serviceId)).rejects.toThrow(
      'LLM_KEY_ACCESS_DENIED',
    );
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
    await expect(ipc.getHandler('config:get')!()).resolves.toMatchObject({
      apiKeyAccessUpgradeNoticeRequired: true,
    });
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
    expect(todos.get('close-reenable-todo', { channel: 'feishu', identityKey: 'identity-a', ownerId: 'owner-a', authorizationEpoch: 1, rule })?.status).toBe('invalidated');
    await setConfig({}, { feishu: { remoteEnabled: true } });
    expect(epochStore.current('feishu')).toBe(2);
    await setConfig({}, { feishu: { remoteSenderAllowlist: ['owner-b'] } });
    expect(epochStore.current('feishu')).toBe(3);
    expect(todos.claimForDispatch('close-reenable-todo', { channel: 'feishu', identityKey: 'identity-a', ownerId: 'owner-a', authorizationEpoch: 1, rule })).toBeNull();
    unregister();
  });
});
