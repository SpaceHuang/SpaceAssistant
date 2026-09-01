import { describe, expect, it } from 'vitest'
import type { DecisionCacheEntry } from '../../../shared/confirmation/types'
import { groupMemoryEntries, memoryEntrySummary, memoryTierKeyOf } from './toolsSecurityFormat'

function entry(partial: Partial<DecisionCacheEntry>): DecisionCacheEntry {
  return {
    id: 'x',
    key: { kind: 'shell-command', verb: 'git status', level: 'exact' },
    decision: 'allow',
    lane: '*',
    scope: 'persistent',
    createdAt: 1,
    lastHitAt: 1,
    hitCount: 0,
    source: 'user-confirm',
    ...partial
  }
}

describe('toolsSecurityFormat（确认记忆展示装配）', () => {
  it('memoryTierKeyOf：各键型映射档位 i18n key', () => {
    expect(memoryTierKeyOf({ kind: 'shell-command', verb: 'git', level: 'exact' })).toBe('toolsSecurity.memory.tierExact')
    expect(memoryTierKeyOf({ kind: 'shell-command', verb: 'git', target: 'push', level: 'verb+target' })).toBe(
      'toolsSecurity.memory.tierVerbTarget'
    )
    expect(memoryTierKeyOf({ kind: 'domain', domain: 'a.com', level: 'domain+action' })).toBe(
      'toolsSecurity.memory.tierDomainAction'
    )
    expect(memoryTierKeyOf({ kind: 'domain', domain: 'a.com', level: 'domain-any-action' })).toBe(
      'toolsSecurity.memory.tierDomainAny'
    )
    expect(memoryTierKeyOf({ kind: 'path', path: '/tmp/a', level: 'zone' })).toBe('toolsSecurity.memory.tierZone')
    expect(memoryTierKeyOf({ kind: 'mcp-tool', serverId: 's', toolName: 't' })).toBe('toolsSecurity.memory.tierMcpTool')
    expect(memoryTierKeyOf({ kind: 'remote-write', sessionId: 's1' })).toBe('toolsSecurity.memory.tierRemoteWrite')
  })

  it('memoryEntrySummary：按键型产出规范化摘要', () => {
    expect(memoryEntrySummary({ kind: 'shell-command', verb: 'git', target: 'push', level: 'verb+target' })).toBe('git push')
    expect(memoryEntrySummary({ kind: 'domain', domain: 'a.com', level: 'domain-any-action' })).toBe('a.com')
    expect(memoryEntrySummary({ kind: 'mcp-tool', serverId: 'fs', toolName: 'read' })).toBe('fs/read')
  })

  it('groupMemoryEntries：按作用域+档位分组，持久组在前', () => {
    const groups = groupMemoryEntries([
      entry({ id: '1', scope: 'session' }),
      entry({ id: '2' }),
      entry({ id: '3', key: { kind: 'domain', domain: 'a.com', level: 'domain-any-action' } }),
      entry({ id: '4' })
    ])
    expect(groups.map((g) => [g.scope, g.entries.map((e) => e.id)])).toEqual([
      ['persistent', ['2', '4']],
      ['persistent', ['3']],
      ['session', ['1']]
    ])
    expect(groups[0]!.tierKey).toBe('toolsSecurity.memory.tierExact')
  })
})
