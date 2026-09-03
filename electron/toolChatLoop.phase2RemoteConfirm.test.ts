import { describe, expect, it } from 'vitest'
import { evaluateToolCallGate, type ToolCallGateArgs } from './confirmation/toolCallGate'
import { DEFAULT_FEISHU_CONFIG, type FeishuConfig } from '../src/shared/feishuTypes'
import { DEFAULT_WECHAT_CONFIG } from '../src/shared/wechatTypes'
import {
  DEFAULT_BROWSER_CONFIG,
  DEFAULT_TOOLS_CONFIG,
  type BrowserConfig,
  type ToolsConfig
} from '../src/shared/domainTypes'
import type { RemoteContext } from './tools/types'

const feishuRemote: RemoteContext = {
  source: 'feishu',
  messageId: 'm1',
  confirmPolicy: 'always'
}

const toolsConfig: ToolsConfig = { ...DEFAULT_TOOLS_CONFIG, deniedTools: [] }

async function needsConfirm(
  toolName: string,
  toolInput: Record<string, unknown>,
  overrides: Partial<ToolCallGateArgs> = {}
): Promise<boolean> {
  const r = await evaluateToolCallGate({
    toolName,
    toolInput,
    sessionId: 's1',
    workDir: '/tmp/wd',
    userDataDir: '/tmp/ud',
    toolsConfig,
    audit: { record: () => undefined },
    ...overrides
  })
  return r.decision.type === 'require-confirm'
}

const lark = (args: unknown[], feishuConfig: FeishuConfig) =>
  needsConfirm('run_lark_cli', { args }, { feishuConfig })

describe('phase2 remote confirm defaults（经 toolCallGate + 规则表）', () => {
  it('larkCliWriteRequiresConfirm defaults true; high-impact always asks', async () => {
    expect(DEFAULT_FEISHU_CONFIG.larkCliWriteRequiresConfirm).toBe(true)
    expect(await lark(['message', 'send', '--receive-id', 'ou_1'], DEFAULT_FEISHU_CONFIG)).toBe(true)
    // Even when switch is false, group/high-impact still asks.
    expect(
      await lark(['message', 'send', '--chat-type', 'group', '--receive-id', 'oc_x'], {
        ...DEFAULT_FEISHU_CONFIG,
        larkCliWriteRequiresConfirm: false
      })
    ).toBe(true)
  })

  it('low-impact lark write can skip when switch explicitly false', async () => {
    expect(
      await lark(['message', 'send', '--receive-id', 'ou_1'], {
        ...DEFAULT_FEISHU_CONFIG,
        larkCliWriteRequiresConfirm: false
      })
    ).toBe(false)
  })

  it('high-impact ops always confirm even when old write-pair list misses them', async () => {
    const noConfirm = { ...DEFAULT_FEISHU_CONFIG, larkCliWriteRequiresConfirm: false }
    expect(await lark(['doc', 'delete', '--token', 't'], noConfirm)).toBe(true)
    expect(await lark(['doc', 'permission', 'update'], noConfirm)).toBe(true)
    expect(await lark(['calendar', 'delete', '--event-id', 'e1'], noConfirm)).toBe(true)
  })

  it('read ops do not confirm when routed solely through impact classifier', async () => {
    expect(
      await lark(['doc', 'get', '--token', 't'], {
        ...DEFAULT_FEISHU_CONFIG,
        larkCliWriteRequiresConfirm: true
      })
    ).toBe(false)
  })

  it('non-string args fail closed to confirm without throwing', async () => {
    await expect(lark(['doc', 1], DEFAULT_FEISHU_CONFIG)).resolves.not.toThrow
    expect(
      await lark(['doc', 1], { ...DEFAULT_FEISHU_CONFIG, larkCliWriteRequiresConfirm: false })
    ).toBe(true)
  })

  it('explicit larkCliWriteRequiresConfirm true still requires confirm for writes', async () => {
    expect(
      await lark(['message', 'send', '--receive-id', 'ou_1'], {
        ...DEFAULT_FEISHU_CONFIG,
        larkCliWriteRequiresConfirm: true
      })
    ).toBe(true)
  })

  it('desktop browser defaults remain navigate/act require confirm', async () => {
    expect(DEFAULT_BROWSER_CONFIG.navigateRequiresConfirm).toBe(true)
    expect(DEFAULT_BROWSER_CONFIG.actRequiresConfirm).toBe(true)
    expect(
      await needsConfirm(
        'browser',
        { action: 'navigate', url: 'https://example.com' },
        { browserConfig: DEFAULT_BROWSER_CONFIG }
      )
    ).toBe(true)
  })

  it('pre-migration: navigate may skip but act still confirms (conservative overlay)', async () => {
    expect(DEFAULT_FEISHU_CONFIG.remoteBrowserRequiresConfirm).toBe(false)
    const browserConfig: BrowserConfig = { ...DEFAULT_BROWSER_CONFIG, allowRemoteSessions: true }
    // navigate is not gated by the migration overlay（远程开关默认放行 → 不确认）
    expect(
      await needsConfirm(
        'browser',
        { action: 'navigate', url: 'https://example.com' },
        { remoteContext: feishuRemote, feishuConfig: DEFAULT_FEISHU_CONFIG, browserConfig }
      )
    ).toBe(false)
    // act must NOT skip until migration completes.
    expect(
      await needsConfirm(
        'browser',
        { action: 'act', instruction: 'click' },
        { remoteContext: feishuRemote, feishuConfig: DEFAULT_FEISHU_CONFIG, browserConfig }
      )
    ).toBe(true)
    // screenshot 等非 navigate/act 动作本就免确认
    expect(
      await needsConfirm(
        'browser',
        { action: 'screenshot' },
        { remoteContext: feishuRemote, feishuConfig: DEFAULT_FEISHU_CONFIG, browserConfig }
      )
    ).toBe(false)
  })

  it('migrated: act skips only when remoteBrowserActRequiresConfirm is false', async () => {
    const migrated = {
      ...DEFAULT_FEISHU_CONFIG,
      remoteSecurityConfigVersion: 1,
      remoteBrowserActRequiresConfirm: false,
      remoteBrowserNavigateRequiresConfirm: false
    }
    const browserConfig: BrowserConfig = { ...DEFAULT_BROWSER_CONFIG, allowRemoteSessions: true }
    expect(
      await needsConfirm(
        'browser',
        { action: 'act', instruction: 'click' },
        { remoteContext: feishuRemote, feishuConfig: migrated, browserConfig }
      )
    ).toBe(false)
    expect(
      await needsConfirm(
        'browser',
        { action: 'act', instruction: 'click' },
        {
          remoteContext: feishuRemote,
          feishuConfig: { ...migrated, remoteBrowserActRequiresConfirm: true },
          browserConfig
        }
      )
    ).toBe(true)
  })

  it('remote browser still confirms when remoteBrowserRequiresConfirm is true', async () => {
    const browserConfig: BrowserConfig = { ...DEFAULT_BROWSER_CONFIG, allowRemoteSessions: true }
    expect(
      await needsConfirm(
        'browser',
        { action: 'navigate', url: 'https://example.com' },
        {
          remoteContext: feishuRemote,
          feishuConfig: { ...DEFAULT_FEISHU_CONFIG, remoteBrowserRequiresConfirm: true },
          browserConfig
        }
      )
    ).toBe(true)
  })

  it('changing remoteBrowserRequiresConfirm does not change DEFAULT_BROWSER_CONFIG', () => {
    expect(DEFAULT_WECHAT_CONFIG.remoteBrowserRequiresConfirm).toBe(false)
    expect(DEFAULT_BROWSER_CONFIG.navigateRequiresConfirm).toBe(true)
  })
})
