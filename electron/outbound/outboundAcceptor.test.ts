import { describe, expect, it, vi } from 'vitest'
import { decideOutbound, type OutboundSnapshot } from './outboundAcceptor'
import type { OutboundSubmitIntent } from '../../src/shared/outboundProtocol'
import { DEFAULT_WIKI_CONFIG } from '../../src/shared/domainTypes'

function makeSnapshot(overrides: Partial<OutboundSnapshot> = {}): OutboundSnapshot {
  return {
    isDev: true,
    sessionExists: true,
    sessionRunning: false,
    activeTurnCount: 0,
    maxParallel: 3,
    apiKeyPresent: true,
    queuedCount: 0,
    maxQueueSize: 10,
    wikiConfig: { ...DEFAULT_WIKI_CONFIG, enabled: true },
    sessionSkillsState: { manualActivated: [], manualDisabled: [] },
    ...overrides
  }
}

const io = {
  listSkills: vi.fn(async () => []),
  getSkill: vi.fn(async () => null),
  wikiInit: vi.fn(async () => ({ ok: true as const, rootPath: 'llm-wiki', skillInstalled: true })),
  wikiStatus: vi.fn(async () => ({
    enabled: true,
    rootPath: 'llm-wiki',
    initialized: true,
    pageCount: 1,
    rawCount: 0
  })),
  wikiImportRaw: vi.fn(async ({ srcRelPath }: { srcRelPath: string }) => ({
    ok: true as const,
    rawRelPath: srcRelPath,
    copied: false
  }))
}

describe('decideOutbound（出站决定矩阵）', () => {
  it('test-pop run → local-command（无需会话，开发模式）', async () => {
    const d = await decideOutbound({ text: '/test-pop' }, makeSnapshot({ sessionExists: false }), io)
    expect(d).toEqual({ action: 'local-command', command: { kind: 'test-pop-run' } })
  })

  it('test-pop 非开发模式 → hint-only', async () => {
    const d = await decideOutbound({ text: '/test-pop' }, makeSnapshot({ isDev: false }), io)
    expect(d).toMatchObject({ action: 'hint-only' })
    if (d.action === 'hint-only') expect(d.hint).toContain('仅在开发模式下可用')
  })

  it('普通文本但无会话 → 拒绝（会话创建是主进程决定，失败不得静默降级）', async () => {
    const d = await decideOutbound({ text: '你好' }, makeSnapshot({ sessionExists: false }), io)
    expect(d).toMatchObject({ action: 'reject', reason: 'OUTBOUND_SESSION_NOT_FOUND' })
  })

  it('未运行但跨会话并发满 → 拒绝', async () => {
    const d = await decideOutbound(
      { text: '你好' },
      makeSnapshot({ activeTurnCount: 3, maxParallel: 3 }),
      io
    )
    expect(d).toMatchObject({ action: 'reject', reason: 'OUTBOUND_MAX_PARALLEL_REACHED' })
  })

  it('test-cards run 开发模式且未运行 → local-command（渲染端本地预览，不发 turn）', async () => {
    const d = await decideOutbound({ text: '/test-cards' }, makeSnapshot(), io)
    expect(d).toEqual({ action: 'local-command', command: { kind: 'test-cards-run' } })
  })

  it('test-cards run 开发模式但会话运行中 → 排队', async () => {
    const d = await decideOutbound({ text: '/test-cards' }, makeSnapshot({ sessionRunning: true }), io)
    expect(d).toMatchObject({ action: 'enqueue' })
  })

  it('排队已满 → 拒绝', async () => {
    const d = await decideOutbound(
      { text: '你好' },
      makeSnapshot({ sessionRunning: true, queuedCount: 10, maxQueueSize: 10 }),
      io
    )
    expect(d).toMatchObject({ action: 'reject', reason: 'OUTBOUND_QUEUE_FULL' })
  })

  it('缺 API Key → 拒绝', async () => {
    const d = await decideOutbound({ text: '你好' }, makeSnapshot({ apiKeyPresent: false }), io)
    expect(d).toMatchObject({ action: 'reject', reason: 'OUTBOUND_API_KEY_MISSING' })
  })

  it('wiki 命令型（help）→ hint-only', async () => {
    const d = await decideOutbound({ text: '/wiki help' }, makeSnapshot(), io)
    expect(d.action).toBe('hint-only')
  })

  it('wiki run 型（query）→ start-turn，携带 skillsState 与 wikiModeActive', async () => {
    const d = await decideOutbound({ text: '/wiki query 如何重构' }, makeSnapshot(), io)
    expect(d).toMatchObject({ action: 'start-turn', wikiModeActive: true })
    if (d.action === 'start-turn') {
      expect(d.text).toBe('如何重构')
      expect(d.skillsState?.manualActivated).toContain('llm-wiki')
    }
  })

  it('skill 命令型（list）→ hint-only', async () => {
    const d = await decideOutbound({ text: '/skill list' }, makeSnapshot(), io)
    expect(d.action).toBe('hint-only')
  })

  it('会话运行中 + 普通文本 → 排队（不是拒绝也不是并发发起）', async () => {
    const d = await decideOutbound({ text: '继续' }, makeSnapshot({ sessionRunning: true }), io)
    expect(d).toMatchObject({ action: 'enqueue', text: '继续' })
  })

  it('会话运行中 + reuse-user 意图（重试）→ 拒绝（对齐渲染端运行守卫；排水器在 active 清零后才驱动）', async () => {
    const d = await decideOutbound(
      {
        text: '继续',
        contextIntent: {
          kind: 'reuse-user',
          currentUser: { message: { id: 'u1' } as never, order: { kind: 'persisted', sequence: 3 } },
          requestId: 'req-1'
        }
      },
      makeSnapshot({ sessionRunning: true }),
      io
    )
    expect(d).toMatchObject({ action: 'reject', reason: 'OUTBOUND_SESSION_RUNNING' })
  })

  it('普通文本 + 未运行 → start-turn（create-user 原文）', async () => {
    const d = await decideOutbound({ text: '  你好  ' }, makeSnapshot(), io)
    expect(d).toMatchObject({ action: 'start-turn', text: '你好' })
  })
})
