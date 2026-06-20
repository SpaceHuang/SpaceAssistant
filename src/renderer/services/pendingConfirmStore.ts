import type { AutoApproveFallback, BrowserActDangerInfo, ShellSecurityHints, ToolCallRecord, ToolRiskLevel } from '../../shared/domainTypes'
import type { ToolConfirmOptions } from '../../shared/toolConfirm'
import { resolveSessionIdForRequest } from './runRequestIndex'

export type PendingConfirmItem = {
  sessionId: string
  requestId: string
  toolUseId: string
  toolName: string
  input: unknown
  riskLevel: ToolRiskLevel
  diff?: ToolCallRecord['confirmDiff']
  shellSecurityHints?: ShellSecurityHints
  autoApproveFallback?: AutoApproveFallback
  currentPageUrl?: string
  dangerInfo?: BrowserActDangerInfo
  sessionTrustedHint?: true
  createdAt: number
}

type Listener = () => void

class PendingConfirmStore {
  private items: PendingConfirmItem[] = []
  private listeners = new Set<Listener>()
  private initialized = false
  private unsubConfirm: (() => void) | null = null
  private unsubResult: (() => void) | null = null

  init(): void {
    if (this.initialized) return
    this.initialized = true

    this.unsubConfirm = window.api.toolOnConfirmRequest((d) => {
      const sessionId = resolveSessionIdForRequest(d.requestId)
      if (!sessionId) return
      if (this.items.some((i) => i.requestId === d.requestId && i.toolUseId === d.toolUseId)) return
      this.items.push({
        sessionId,
        requestId: d.requestId,
        toolUseId: d.toolUseId,
        toolName: d.toolName,
        input: d.input,
        riskLevel: d.riskLevel,
        diff: d.diff,
        shellSecurityHints: d.shellSecurityHints,
        autoApproveFallback: d.autoApproveFallback,
        ...(d.currentPageUrl ? { currentPageUrl: d.currentPageUrl } : {}),
        ...(d.dangerInfo ? { dangerInfo: d.dangerInfo } : {}),
        ...(d.sessionTrustedHint ? { sessionTrustedHint: d.sessionTrustedHint } : {}),
        createdAt: Date.now()
      })
      this.notify()
    })

    this.unsubResult = window.api.toolOnResult((d) => {
      this.remove(d.requestId, d.toolUseId)
    })
  }

  dispose(): void {
    this.unsubConfirm?.()
    this.unsubResult?.()
    this.unsubConfirm = null
    this.unsubResult = null
    this.initialized = false
    this.items = []
    this.listeners.clear()
  }

  getItems(): PendingConfirmItem[] {
    return [...this.items]
  }

  countForSession(sessionId: string): number {
    return this.items.filter((i) => i.sessionId === sessionId).length
  }

  find(sessionId: string, toolUseId: string): PendingConfirmItem | undefined {
    return this.items.find((i) => i.sessionId === sessionId && i.toolUseId === toolUseId)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  respond(requestId: string, toolUseId: string, approved: boolean, options?: ToolConfirmOptions): void {
    void window.api.toolConfirmResponse({
      requestId,
      toolUseId,
      approved,
      trustCommand: options?.trustCommand,
      trustDomain: options?.trustDomain,
      trustActDomain: options?.trustActDomain
    })
    this.remove(requestId, toolUseId)
  }

  rejectAllForSession(sessionId: string): void {
    const pending = this.items.filter((i) => i.sessionId === sessionId)
    for (const item of pending) {
      void window.api.toolConfirmResponse({
        requestId: item.requestId,
        toolUseId: item.toolUseId,
        approved: false
      })
    }
    this.items = this.items.filter((i) => i.sessionId !== sessionId)
    this.notify()
  }

  remove(requestId: string, toolUseId: string): void {
    const before = this.items.length
    this.items = this.items.filter((i) => !(i.requestId === requestId && i.toolUseId === toolUseId))
    if (this.items.length !== before) this.notify()
  }

  removeAllForRequest(requestId: string): void {
    const before = this.items.length
    this.items = this.items.filter((i) => i.requestId !== requestId)
    if (this.items.length !== before) this.notify()
  }

  reconcileForSession(sessionId: string, activeRequestIds: Set<string>): void {
    const before = this.items.length
    this.items = this.items.filter(
      (i) => i.sessionId !== sessionId || activeRequestIds.has(i.requestId)
    )
    if (this.items.length !== before) this.notify()
  }

  /** 测试用 */
  reset(): void {
    this.items = []
    this.notify()
  }

  private notify(): void {
    for (const l of this.listeners) l()
  }
}

export const pendingConfirmStore = new PendingConfirmStore()
