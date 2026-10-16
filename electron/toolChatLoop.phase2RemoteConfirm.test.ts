import { DEFAULT_POLICY_RULES } from '../src/shared/policy/defaultRules'
import { describe, expect, it } from 'vitest'
import { evaluateToolCallGate, type ToolCallGateArgs } from './confirmation/toolCallGate'
import {
  DEFAULT_BROWSER_CONFIG,
  DEFAULT_TOOLS_CONFIG,
  type BrowserConfig,
  type ToolsConfig
} from '../src/shared/domainTypes'
import type { RemoteContext } from './tools/types'

const feishuRemote: RemoteContext = {
  source: 'feishu',
  messageId: 'm1'
}

const toolsConfig: ToolsConfig = { ...DEFAULT_TOOLS_CONFIG, deniedTools: [] }

const imPolicySnapshot = (snapshot: Record<string, unknown> = {}) => ({
  domain: 'im' as const,
  policyBehaviorVersion: 'im-v1.6',
  revision: 1,
  snapshot
})

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
    imPolicySnapshot: imPolicySnapshot({
      larkCliWriteRequiresConfirm: true,
      remoteBrowserNavigateRequiresConfirm: true,
      remoteBrowserActRequiresConfirm: true
    }),
    ...gateDefaultMaterials(),
    ...overrides
  })
  return r.decision.type === 'require-confirm'
}

const lark = (args: unknown[], policy: Record<string, unknown> = { larkCliWriteRequiresConfirm: true }) =>
  needsConfirm('run_lark_cli', { args }, { imPolicySnapshot: imPolicySnapshot(policy) })


/** P2（B1）：显式默认门控材料（原 appDb 缺失静默回退的显式化）。 */
function gateDefaultMaterials() {
  return {
    effectiveRules: DEFAULT_POLICY_RULES,
    decisionCache: {
      lookup: () => null,
      record: () => undefined,
      clear: () => 0,
      clearAllSession: () => 0,
      expireDormant: () => 0
    },
    shellPrecheck: { touchTrustedCommand: () => undefined }
  }
}

describe('phase2 remote confirm defaults（经 toolCallGate + 规则表）', () => {
  it('shared IM snapshot requires confirmation for lark writes by default; high-impact always asks', async () => {
    expect(await lark(['message', 'send', '--receive-id', 'ou_1'])).toBe(true)
    expect(await lark(['message', 'send', '--chat-type', 'group', '--receive-id', 'oc_x'], { larkCliWriteRequiresConfirm: false })).toBe(true)
  })

  it('low-impact document writes can skip while incomplete outbound messages still require review', async () => {
    expect(await lark(['doc', 'create', '--title', 'Draft'], { larkCliWriteRequiresConfirm: false })).toBe(false)
    expect(await lark(['message', 'send', '--receive-id', 'ou_1'], { larkCliWriteRequiresConfirm: false })).toBe(true)
  })

  it('high-impact ops always confirm even when old write-pair list misses them', async () => {
    const noConfirm = { larkCliWriteRequiresConfirm: false }
    expect(await lark(['doc', 'delete', '--token', 't'], noConfirm)).toBe(true)
    expect(await lark(['doc', 'permission', 'update'], noConfirm)).toBe(true)
    expect(await lark(['calendar', 'delete', '--event-id', 'e1'], noConfirm)).toBe(true)
  })

  it('read ops do not confirm when routed solely through impact classifier', async () => {
    expect(
      await lark(['doc', 'get', '--token', 't'], { larkCliWriteRequiresConfirm: true })
    ).toBe(false)
  })

  it('non-string args fail closed to confirm without throwing', async () => {
    await expect(lark(['doc', 1])).resolves.not.toThrow
    expect(
      await lark(['doc', 1], { larkCliWriteRequiresConfirm: false })
    ).toBe(true)
  })

  it('shared IM snapshot explicitly requiring confirmation requires it for lark writes', async () => {
    expect(await lark(['message', 'send', '--receive-id', 'ou_1'], { larkCliWriteRequiresConfirm: true })).toBe(true)
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

  it('remote browser confirmation behavior comes from the shared IM snapshot', async () => {
    const browserConfig: BrowserConfig = { ...DEFAULT_BROWSER_CONFIG, allowRemoteSessions: true }
    expect(
      await needsConfirm(
        'browser',
        { action: 'navigate', url: 'https://example.com' },
        { remoteContext: feishuRemote, browserConfig, imPolicySnapshot: imPolicySnapshot({ remoteBrowserNavigateRequiresConfirm: false, remoteBrowserActRequiresConfirm: true }) }
      )
    ).toBe(false)
    expect(
      await needsConfirm(
        'browser',
        { action: 'act', instruction: 'click' },
        { remoteContext: feishuRemote, browserConfig, imPolicySnapshot: imPolicySnapshot({ remoteBrowserActRequiresConfirm: true }) }
      )
    ).toBe(true)
    expect(
      await needsConfirm(
        'browser',
        { action: 'screenshot' },
        { remoteContext: feishuRemote, browserConfig }
      )
    ).toBe(false)
  })

  it('shared IM snapshot permits browser act only when the action requires no confirmation', async () => {
    const browserConfig: BrowserConfig = { ...DEFAULT_BROWSER_CONFIG, allowRemoteSessions: true }
    expect(
      await needsConfirm(
        'browser',
        { action: 'act', instruction: 'click' },
        { remoteContext: feishuRemote, browserConfig, imPolicySnapshot: imPolicySnapshot({ remoteBrowserActRequiresConfirm: false }) }
      )
    ).toBe(false)
    expect(
      await needsConfirm(
        'browser',
        { action: 'act', instruction: 'click' },
        {
          remoteContext: feishuRemote,
          browserConfig,
          imPolicySnapshot: imPolicySnapshot({ remoteBrowserActRequiresConfirm: true })
        }
      )
    ).toBe(true)
  })

  it('remote browser confirms when the shared snapshot requires navigate confirmation', async () => {
    const browserConfig: BrowserConfig = { ...DEFAULT_BROWSER_CONFIG, allowRemoteSessions: true }
    expect(
      await needsConfirm(
        'browser',
        { action: 'navigate', url: 'https://example.com' },
        {
          remoteContext: feishuRemote,
          browserConfig,
          imPolicySnapshot: imPolicySnapshot({ remoteBrowserNavigateRequiresConfirm: true })
        }
      )
    ).toBe(true)
  })

  it('legacy channel fields do not replace shared IM policy', async () => {
    expect(DEFAULT_BROWSER_CONFIG.navigateRequiresConfirm).toBe(true)
    const browserConfig: BrowserConfig = { ...DEFAULT_BROWSER_CONFIG, allowRemoteSessions: true }
    expect(await needsConfirm('browser', { action: 'navigate', url: 'https://example.com' }, {
      remoteContext: feishuRemote,
      browserConfig,
      feishuConfig: { remoteBrowserRequiresConfirm: true } as never,
      imPolicySnapshot: imPolicySnapshot({ remoteBrowserNavigateRequiresConfirm: false })
    })).toBe(false)
  })

  it('fails closed when a remote call has no shared IM snapshot', async () => {
    await expect(needsConfirm('run_lark_cli', { args: ['message', 'send', '--receive-id', 'ou_1'] }, {
      remoteContext: feishuRemote,
      imPolicySnapshot: null as never
    })).rejects.toThrow('IM_POLICY_SNAPSHOT_REQUIRED')
  })
})
