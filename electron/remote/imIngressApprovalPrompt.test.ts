import { afterEach, describe, expect, it, vi } from 'vitest'

const { getMainWindow, promptState, FakeBrowserWindow } = vi.hoisted(() => {
  const promptState: { decision: 'approve' | 'reject' | 'pending'; windows: Array<{ options: unknown; html: string; handlers: Map<string, (...args: unknown[]) => void>; shown: boolean; closed: boolean }>; beforeCreate?: () => void } = { decision: 'approve', windows: [] }
  class FakeBrowserWindow {
    readonly record = { options: {} as unknown, html: '', handlers: new Map<string, (...args: unknown[]) => void>(), shown: false, closed: false }
    readonly webContents = { on: (name: string, handler: (...args: unknown[]) => void) => this.record.handlers.set(`web:${name}`, handler) }
    constructor(options: unknown) { this.record.options = options; promptState.windows.push(this.record) }
    on(name: string, handler: (...args: unknown[]) => void) { this.record.handlers.set(name, handler) }
    loadURL(url: string) {
      this.record.html = decodeURIComponent(url.slice(url.indexOf(',') + 1))
      queueMicrotask(() => {
        if (promptState.decision === 'pending') return
        const navigate = this.record.handlers.get('web:will-navigate')
        navigate?.({ preventDefault() {} }, `spaceassistant-approval://${promptState.decision}`)
      })
      return Promise.resolve()
    }
    show() { this.record.shown = true }
    close() { if (this.record.closed) return; this.record.closed = true; this.record.handlers.get('closed')?.() }
    isDestroyed() { return this.record.closed }
  }
  return { getMainWindow: vi.fn(() => { promptState.beforeCreate?.(); return { id: 4 } }), promptState, FakeBrowserWindow }
})

vi.mock('electron', () => ({ BrowserWindow: FakeBrowserWindow, app: { isPackaged: false } }))
vi.mock('../windowRef', () => ({ getMainWindow }))

import { requestImExposureApproval, requestImIngressApproval } from './imIngressApprovalPrompt'

afterEach(() => { vi.clearAllMocks(); promptState.windows.length = 0; promptState.decision = 'approve'; promptState.beforeCreate = undefined })

describe('IM local owner approval prompts', () => {
  it('binds ingress approval details to the exact source message and uses reject as the safe default', async () => {
    expect(await requestImIngressApproval({ channel: 'wechat', senderId: 'sender-1', messageId: 'msg-7',
      ruleId: 'ingress-direct-other-ask', messageText: 'please run this' })).toBe(true)
    const prompt = promptState.windows[0]!
    expect(prompt.options).toMatchObject({ title: '微信消息需要批准', parent: { id: 4 }, modal: true })
    expect(prompt.html).toContain('msg-7')
    expect(prompt.html).toContain('please run this')
    expect(prompt.html).toContain('拒绝')
    expect(prompt.html).toContain('规则')
  })

  it('keeps an exposure target unavailable unless the exact local approval dialog is accepted', async () => {
    promptState.decision = 'reject'
    expect(await requestImExposureApproval({ lane: 'feishu', toolName: 'wechat_send', ruleId: 'im-no-wechat-send' })).toBe(false)
    expect(promptState.windows[0]?.html).toContain('wechat_send')
    expect(promptState.windows[0]?.options).toMatchObject({ title: '确认开放工具', modal: true })
  })

  it('uses the configured English locale consistently for approval prompts', async () => {
    const { createMemoryAppDb } = await import('../database/testHelpers')
    const { setConfigValue } = await import('../database')
    const db = createMemoryAppDb()
    setConfigValue(db, 'config.locale', 'en-US')
    try {
      await requestImIngressApproval({ db, channel: 'feishu', senderId: 'sender', messageId: 'message',
        ruleId: 'ingress-rule', messageText: 'hello' })
      const html = promptState.windows[0]?.html ?? ''
      expect(html).toContain('Feishu message approval')
      expect(html).toContain('Reject')
      expect(html).toContain('Approve and continue processing this message')
      expect(html).not.toContain('拒绝')
    } finally { db.close() }
  })

  it('closes a stale approval prompt when its policy wait is aborted', async () => {
    promptState.decision = 'pending'
    const controller = new AbortController()
    const pending = requestImIngressApproval({ channel: 'wechat', senderId: 'sender', messageId: 'msg-stale',
      ruleId: 'ingress-direct-other-ask', messageText: 'text', signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    await expect(pending).resolves.toBe(false)
    expect(promptState.windows[0]?.closed).toBe(true)
  })

  it('closes the prompt when the signal aborts while the window is being created', async () => {
    const controller = new AbortController()
    promptState.decision = 'pending'
    promptState.beforeCreate = () => controller.abort()
    await expect(requestImIngressApproval({ channel: 'wechat', senderId: 'sender', messageId: 'creation-race',
      ruleId: 'ingress-rule', messageText: 'text', signal: controller.signal })).resolves.toBe(false)
    expect(promptState.windows[0]?.closed).toBe(true)
    expect(promptState.windows[0]?.shown).toBe(false)
  })
})
