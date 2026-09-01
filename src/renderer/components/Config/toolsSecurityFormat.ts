import type { CacheKey, DecisionCacheEntry } from '../../../shared/confirmation/types'
import type { NamespaceKeyMap } from '../../i18n/types'

/**
 * 「工具与安全 → 确认记忆管理」的展示装配（纯函数，可单测）：
 * 缓存键 → 档位 i18n key + 内容摘要；条目按 作用域+档位 分组。
 */

/** 档位 i18n key（config 命名空间 toolsSecurity.memory.*）。 */
export function memoryTierKeyOf(key: CacheKey): NamespaceKeyMap['config'] {
  switch (key.kind) {
    case 'shell-command':
      if (key.level === 'verb+target') return 'toolsSecurity.memory.tierVerbTarget'
      if (key.level === 'verb') return 'toolsSecurity.memory.tierVerb'
      return 'toolsSecurity.memory.tierExact'
    case 'domain':
      return key.level === 'domain+action'
        ? 'toolsSecurity.memory.tierDomainAction'
        : 'toolsSecurity.memory.tierDomainAny'
    case 'path':
      if (key.level === 'directory') return 'toolsSecurity.memory.tierDirectory'
      if (key.level === 'zone') return 'toolsSecurity.memory.tierZone'
      return 'toolsSecurity.memory.tierFile'
    case 'mcp-tool':
      return 'toolsSecurity.memory.tierMcpTool'
    case 'remote-write':
      return 'toolsSecurity.memory.tierRemoteWrite'
  }
}

/** 内容摘要（事实文本，不落原始输入全文——键本身即规范化签名）。 */
export function memoryEntrySummary(key: CacheKey): string {
  switch (key.kind) {
    case 'shell-command':
      return key.target ? `${key.verb} ${key.target}` : key.verb
    case 'domain':
      return key.domain
    case 'path':
      return key.path
    case 'mcp-tool':
      return `${key.serverId}/${key.toolName}`
    case 'remote-write':
      return key.sessionId
  }
}

export interface MemoryGroup {
  /** 分组键：scope:tierKey */
  id: string
  scope: DecisionCacheEntry['scope']
  tierKey: NamespaceKeyMap['config']
  entries: DecisionCacheEntry[]
}

/** 按 作用域 → 档位 分组（组内保持传入顺序，主进程已按创建时间倒序）。 */
export function groupMemoryEntries(entries: DecisionCacheEntry[]): MemoryGroup[] {
  const order: MemoryGroup[] = []
  const byId = new Map<string, MemoryGroup>()
  for (const entry of entries) {
    const tierKey = memoryTierKeyOf(entry.key)
    const id = `${entry.scope}:${tierKey}`
    let group = byId.get(id)
    if (!group) {
      group = { id, scope: entry.scope, tierKey, entries: [] }
      byId.set(id, group)
      order.push(group)
    }
    group.entries.push(entry)
  }
  // 持久条目在前、会话级在后（持久信任是主要管理对象）
  return order.sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'persistent' ? -1 : 1))
}
