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

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  dialog: { showOpenDialog: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(() => []), setApplicationMenu: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));

vi.mock('./secureApiKey', () => ({
  isSecretStorageAvailable: () => true,
  encryptSecret: (plain: string) => `enc:${plain}`,
  decryptSecret: (enc: string) => enc.replace(/^enc:/, ''),
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

    await expect(getLlmServiceApiKey(db, serviceId)).resolves.toBe(
      'old-secret',
    );
    expect(readLlmServices(db)[0]?.name).toBe('Old name');
    expect(JSON.parse(getConfigValue(db, 'config.models') ?? '[]')).toEqual([
      oldModel,
    ]);
  });
});
