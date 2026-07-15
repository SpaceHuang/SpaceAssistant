import { describe, expect, it } from 'vitest'
import {
  shouldSkipRemoteBrowserConfirm,
  toolNeedsUserConfirmationForTests
} from './toolChatLoop'
import { DEFAULT_FEISHU_CONFIG } from '../src/shared/feishuTypes'
import { DEFAULT_WECHAT_CONFIG } from '../src/shared/wechatTypes'
import { DEFAULT_BROWSER_CONFIG } from '../src/shared/domainTypes'
import type { RemoteContext } from './tools/types'

const feishuRemote: RemoteContext = {
  source: 'feishu',
  messageId: 'm1',
  confirmPolicy: 'always'
}

describe('phase2 remote confirm defaults', () => {
  it('larkCliWriteRequiresConfirm defaults false so write ops skip confirm', () => {
    expect(DEFAULT_FEISHU_CONFIG.larkCliWriteRequiresConfirm).toBe(false)
    expect(
      toolNeedsUserConfirmationForTests(
        'run_lark_cli',
        { args: ['message', 'send'] },
        DEFAULT_FEISHU_CONFIG
      )
    ).toBe(false)
  })

  it('explicit larkCliWriteRequiresConfirm true still requires confirm for writes', () => {
    expect(
      toolNeedsUserConfirmationForTests(
        'run_lark_cli',
        { args: ['message', 'send'] },
        { ...DEFAULT_FEISHU_CONFIG, larkCliWriteRequiresConfirm: true }
      )
    ).toBe(true)
  })

  it('desktop browser defaults remain navigate/act require confirm', () => {
    expect(DEFAULT_BROWSER_CONFIG.navigateRequiresConfirm).toBe(true)
    expect(DEFAULT_BROWSER_CONFIG.actRequiresConfirm).toBe(true)
    expect(
      toolNeedsUserConfirmationForTests(
        'browser',
        { action: 'navigate', url: 'https://example.com' },
        undefined,
        undefined,
        DEFAULT_BROWSER_CONFIG
      )
    ).toBe(true)
  })

  it('pre-migration: navigate may skip but act still confirms (conservative overlay)', () => {
    expect(DEFAULT_FEISHU_CONFIG.remoteBrowserRequiresConfirm).toBe(false)
    // navigate is not gated by the migration overlay.
    expect(
      shouldSkipRemoteBrowserConfirm(
        feishuRemote,
        'browser',
        { action: 'navigate', url: 'https://example.com' },
        DEFAULT_FEISHU_CONFIG
      )
    ).toBe(true)
    // act must NOT skip until migration completes.
    expect(
      shouldSkipRemoteBrowserConfirm(
        feishuRemote,
        'browser',
        { action: 'act', instruction: 'click' },
        DEFAULT_FEISHU_CONFIG
      )
    ).toBe(false)
    expect(
      shouldSkipRemoteBrowserConfirm(
        feishuRemote,
        'browser',
        { action: 'screenshot' },
        DEFAULT_FEISHU_CONFIG
      )
    ).toBe(false)
  })

  it('migrated: act skips only when remoteBrowserActRequiresConfirm is false', () => {
    const migrated = {
      ...DEFAULT_FEISHU_CONFIG,
      remoteSecurityConfigVersion: 1,
      remoteBrowserActRequiresConfirm: false,
      remoteBrowserNavigateRequiresConfirm: false
    }
    expect(
      shouldSkipRemoteBrowserConfirm(feishuRemote, 'browser', { action: 'act', instruction: 'click' }, migrated)
    ).toBe(true)
    expect(
      shouldSkipRemoteBrowserConfirm(
        feishuRemote,
        'browser',
        { action: 'act', instruction: 'click' },
        { ...migrated, remoteBrowserActRequiresConfirm: true }
      )
    ).toBe(false)
  })

  it('remote browser still confirms when remoteBrowserRequiresConfirm is true', () => {
    expect(
      shouldSkipRemoteBrowserConfirm(
        feishuRemote,
        'browser',
        { action: 'navigate', url: 'https://example.com' },
        { ...DEFAULT_FEISHU_CONFIG, remoteBrowserRequiresConfirm: true }
      )
    ).toBe(false)
  })

  it('changing remoteBrowserRequiresConfirm does not change DEFAULT_BROWSER_CONFIG', () => {
    expect(DEFAULT_WECHAT_CONFIG.remoteBrowserRequiresConfirm).toBe(false)
    expect(DEFAULT_BROWSER_CONFIG.navigateRequiresConfirm).toBe(true)
  })
})
