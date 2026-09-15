import type { CompactionReplay } from './compactionEvents'
import { buildRequestHeaderPayload } from './requestContext'

export type SurfaceReplayItem = { id: string; required?: boolean }

/** 将 provider 的 assistant content blocks 投影成数据库持久化的正文表示。 */
export function canonicalSurfaceContent(role: unknown, content: unknown): unknown {
  if (role === 'user' && Array.isArray(content)) {
    const hasToolResult = content.some((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_result')
    if (!hasToolResult) return content
    const retained = content.filter((block) => !block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'tool_result')
    if (retained.length > 0 && retained.every((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')) {
      return canonicalPersistedAssistantText(retained.map((block) => (block as { text: string }).text).join(''))
    }
    return retained
  }
  if (role !== 'assistant') return content
  // `''` is the deliberate replay anchor for a tool-use assistant without text;
  // ordinary persisted empty assistant messages are normalized by the DB builder
  // to `' '` before reaching this layer.
  if (typeof content === 'string') return content.length === 0 ? '' : canonicalPersistedAssistantText(content)
  if (!Array.isArray(content)) return content
  const hasToolUse = content.some((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_use')
  const text = extractAssistantText(content)
  // 带 tool_use 的 assistant 正文由数据库的 toolCalls 重建，原文空白需要保留；
  // 普通 assistant 则会经过 ensureApiTextContent（trim，空正文变成单空格）。
  return hasToolUse ? text : canonicalPersistedAssistantText(text)
}

function extractAssistantText(content: unknown[]): string {
  return content
    .filter((block): block is { type?: unknown; text?: unknown } => Boolean(block) && typeof block === 'object')
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function canonicalPersistedAssistantText(content: string): string {
  const trimmed = content.trim()
  return trimmed.length > 0 ? trimmed : ' '
}

export interface ReplaySurfaceProjection<T> {
  messages: T[]
  /** 每个 projected message 对应的原始消息；合并工具轮时指向首个 assistant。 */
  sources: T[]
  /** 每个 projected message 合并了哪些原始消息，用于跨轮稳定 identity。 */
  sourceGroups: T[][]
}

type ReplaySurfaceProjectionOptions<T> = {
  mergeAdjacentUsers?: boolean | ((left: T, right: T) => boolean)
}

/** 将工具协议消息投影为可由数据库稳定重建的 turn surface。 */
export function projectReplaySurfaceWithSources<T>(messages: readonly T[], options: ReplaySurfaceProjectionOptions<T> = {}): ReplaySurfaceProjection<T> {
  const projected: T[] = []
  const sources: T[] = []
  const sourceGroups: T[][] = []
  let toolTurnAssistantIndex = -1
  for (const message of messages) {
    if (!message || typeof message !== 'object') { projected.push(message); sources.push(message); sourceGroups.push([message]); continue }
    const source = message as { role?: unknown; content?: unknown }
    if (source.role === 'user' && Array.isArray(source.content)) {
      if (source.content.every((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_result')) continue
    }
    if (source.role === 'assistant' && Array.isArray(source.content)) {
      const hasToolUse = source.content.some((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_use')
      const rawText = extractAssistantText(source.content)
      const text = canonicalSurfaceContent(source.role, source.content)
      if (hasToolUse) {
        // 空正文的 tool-use assistant 仍是一个可持久化的轮次锚点；否则 reset
        // 删除历史工具对后，projection 前后看起来完全相同，压缩范围无法回放。
        if (toolTurnAssistantIndex < 0) {
          projected.push({ ...(message as object), content: typeof text === 'string' ? text : '' } as T)
          sources.push(message)
          sourceGroups.push([message])
          toolTurnAssistantIndex = projected.length - 1
        } else if (typeof text === 'string' && text.length > 0) {
          const previous = projected[toolTurnAssistantIndex] as unknown as { content?: unknown }
          projected[toolTurnAssistantIndex] = { ...(previous as object), content: `${typeof previous.content === 'string' ? previous.content : ''}${text}` } as T
          sourceGroups[toolTurnAssistantIndex]!.push(message)
        }
        continue
      }
      if (toolTurnAssistantIndex >= 0) {
        const previous = projected[toolTurnAssistantIndex] as unknown as { content?: unknown }
        projected[toolTurnAssistantIndex] = { ...(previous as object), content: `${typeof previous.content === 'string' ? previous.content : ''}${rawText}` } as T
        sourceGroups[toolTurnAssistantIndex]!.push(message)
        toolTurnAssistantIndex = -1
        continue
      }
    }
    if (source.role === 'user') toolTurnAssistantIndex = -1
    const projectedMessage = source.role === 'assistant' ? { ...(message as object), content: canonicalSurfaceContent(source.role, source.content) } as T : { ...(message as object), content: canonicalSurfaceContent(source.role, source.content) } as T
    const previous = projected[projected.length - 1]
    const shouldMergeAdjacentUsers = previous && isUserMessage(previous) && isUserMessage(projectedMessage) && (typeof options.mergeAdjacentUsers === 'function'
      ? options.mergeAdjacentUsers(previous, projectedMessage)
      : options.mergeAdjacentUsers === true)
    if (shouldMergeAdjacentUsers) {
      projected[projected.length - 1] = mergeReplayUserMessages(previous, projectedMessage)
      sources[sources.length - 1] = message
      sourceGroups[sourceGroups.length - 1]!.push(message)
    } else {
      projected.push(projectedMessage)
      sources.push(message)
      sourceGroups.push([message])
    }
  }
  return { messages: projected, sources, sourceGroups }
}

export function projectReplaySurface<T>(messages: readonly T[]): T[] {
  return projectReplaySurfaceWithSources(messages).messages
}

function isUserMessage(value: unknown): value is { role?: unknown; content?: unknown; id?: string; timestamp?: number } {
  return Boolean(value && typeof value === 'object' && (value as { role?: unknown }).role === 'user')
}

function mergeReplayUserMessages<T>(left: T, right: T): T {
  const leftMessage = left as unknown as { content?: unknown; id?: string; timestamp?: number }
  const rightMessage = right as unknown as { content?: unknown; id?: string; timestamp?: number }
  const leftContent = leftMessage.content
  const rightContent = rightMessage.content
  let content: unknown
  if (typeof leftContent === 'string' && typeof rightContent === 'string') content = `${leftContent}\n${rightContent}`.trim()
  else {
    const leftBlocks = typeof leftContent === 'string' ? [{ type: 'text', text: leftContent }] : Array.isArray(leftContent) ? leftContent : []
    const rightBlocks = typeof rightContent === 'string' ? [{ type: 'text', text: rightContent }] : Array.isArray(rightContent) ? rightContent : []
    content = [...leftBlocks, ...rightBlocks]
  }
  return { ...(left as object), content, ...(rightMessage.id ? { id: rightMessage.id } : {}), ...(rightMessage.timestamp != null ? { timestamp: rightMessage.timestamp } : {}) } as T
}

/** 将 replay 结果映射回原始 API surface，保留未被压缩的工具协议块。 */
export function restoreReplaySurface<T extends { id?: string }>(original: readonly T[], replayed: readonly T[]): T[] {
  const identities = surfaceItemIdentities(original)
  const byKey = new Map<string, T>()
  original.forEach((item, index) => {
    byKey.set(item.id ?? identities[index]!, item)
    byKey.set(identities[index]!, item)
  })
  const restored: T[] = []
  for (const item of replayed) {
    const source = byKey.get(item.id ?? '')
    if (!source) { restored.push(item); continue }
    const index = original.indexOf(source)
    let start = index
    while (start >= 2 && isToolResultMessage(original[start - 1]!) && isToolUseMessage(original[start - 2]!)) start -= 2
    let end = index
    while (end + 2 < original.length && isToolResultMessage(original[end + 1]!) && isToolUseMessage(original[end + 2]!)) end += 2
    if (end + 1 < original.length && isToolResultMessage(original[end + 1]!)) end += 1
    for (let cursor = start; cursor <= end; cursor++) restored.push(original[cursor]!)
  }
  return restored
}

function isToolUseMessage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const source = value as { role?: unknown; content?: unknown }
  return source.role === 'assistant' && Array.isArray(source.content) && source.content.some((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_use')
}

function isToolResultMessage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const source = value as { role?: unknown; content?: unknown }
  return source.role === 'user' && Array.isArray(source.content) && source.content.length > 0 && source.content.every((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_result')
}

export function surfaceItemIdentity(value: unknown, fallbackIndex: number): string {
  if (value && typeof value === 'object' && 'role' in value && 'content' in value) {
    const message = value as { role?: unknown; content?: unknown }
    const text = JSON.stringify({ role: message.role, content: canonicalSurfaceContent(message.role, message.content) })
    let hash = 2166136261
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
    return `surface-${(hash >>> 0).toString(16).padStart(8, '0')}`
  }
  const explicit = value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined
  if (explicit) return explicit
  const text = JSON.stringify(value) ?? `index:${fallbackIndex}`
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return `surface-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function surfaceItemIdentities(values: readonly unknown[]): string[] {
  const counts = new Map<string, number>()
  return values.map((value, index) => {
    const base = surfaceItemIdentity(value, index)
    const occurrence = counts.get(base) ?? 0
    counts.set(base, occurrence + 1)
    return occurrence === 0 ? base : `${base}#${occurrence}`
  })
}

/** 为同一 source 的 retained 子集复用原 occurrence identity，避免删除前置重复项后重新编号。 */
export function surfaceItemIdentitiesForSubset(sourceValues: readonly unknown[], retainedValues: readonly unknown[]): string[] {
  const sourceIdentities = surfaceItemIdentities(sourceValues)
  const byReference = new Map<unknown, string>()
  const byExplicitId = new Map<string, string>()
  const byCanonicalBase = new Map<string, string[]>()
  sourceValues.forEach((value, index) => {
    const identity = sourceIdentities[index]!
    byReference.set(value, identity)
    if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') byExplicitId.set((value as { id: string }).id, identity)
    const base = surfaceItemIdentity(value, index)
    const identities = byCanonicalBase.get(base) ?? []
    identities.push(identity)
    byCanonicalBase.set(base, identities)
  })
  const used = new Set<string>()
  const allocate = (identity: string): string => {
    if (!used.has(identity)) {
      used.add(identity)
      return identity
    }
    let occurrence = 1
    while (used.has(`${identity}#${occurrence}`)) occurrence += 1
    const disambiguated = `${identity}#${occurrence}`
    used.add(disambiguated)
    return disambiguated
  }
  return retainedValues.map((value, index) => {
    if (byReference.has(value)) return allocate(byReference.get(value)!)
    const explicitId = value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined
    if (explicitId && byExplicitId.has(explicitId)) return allocate(byExplicitId.get(explicitId)!)
    const base = surfaceItemIdentity(value, index)
    const candidates = byCanonicalBase.get(base)
    const matchingIdentity = candidates?.find((candidate) => !used.has(candidate))
    return allocate(matchingIdentity ?? base)
  })
}

/** 为保留投影按原始 source 复用 input projection identity，避免克隆 assistant 重新领取首个 occurrence。 */
export function surfaceItemIdentitiesForProjectionSubset<T>(source: ReplaySurfaceProjection<T>, retained: ReplaySurfaceProjection<T>): string[] {
  const sourceIdentities = surfaceItemIdentities(source.messages)
  const bySource = new Map<unknown, string>()
  source.sources.forEach((value, index) => bySource.set(value, sourceIdentities[index]!))
  return retained.sources.map((value, index) => bySource.get(value) ?? surfaceItemIdentity(retained.messages[index], index))
}

/** 从 replay 域剔除无法由下一轮事实重建的请求级 Skill 消息。 */
export function excludeReplayOnlyMessages<T>(messages: readonly T[], skillFragments: readonly string[] | undefined): T[] {
  const fragments = (skillFragments ?? []).filter((fragment) => typeof fragment === 'string' && fragment.length > 0)
  const replayOnlyContents = new Set(fragments)
  if (fragments.length > 1) replayOnlyContents.add(fragments.join('\n\n'))
  if (replayOnlyContents.size === 0) return [...messages]
  return messages.filter((message) => {
    if (!message || typeof message !== 'object') return true
    const source = message as { role?: unknown; id?: unknown; content?: unknown }
    return !(source.role === 'user' && typeof source.id !== 'string' && typeof source.content === 'string' && replayOnlyContents.has(source.content))
  })
}

export function computeReplaySurfaceFingerprint(system: string, surface: readonly unknown[]): string {
  // replay 指纹描述历史消息，不应受每轮动态 system prompt 影响。
  void system
  const canonicalSurface = projectReplaySurfaceWithSources(surface, { mergeAdjacentUsers: true }).messages
  return buildRequestHeaderPayload({ requestId: 'replay', system: '', tools: [], messages: canonicalSurface.map((message) => {
    const source = message && typeof message === 'object' ? message as { role?: unknown; content?: unknown } : {}
    return { role: source.role, content: canonicalSurfaceContent(source.role, source.content) }
  }) }).surfaceSnapshot.fingerprint
}

export function computeShadowedRanges<T extends SurfaceReplayItem>(before: readonly T[], after: readonly T[]): Array<{ start: string; end: string }> {
  const retained = new Set(after.map((item) => item.id))
  const removed = before.filter((item) => !retained.has(item.id))
  const ranges: Array<{ start: string; end: string }> = []
  for (const item of removed) {
    const previous = ranges[ranges.length - 1]
    if (previous && before.findIndex((candidate) => candidate.id === item.id) === before.findIndex((candidate) => candidate.id === previous.end) + 1) previous.end = item.id
    else ranges.push({ start: item.id, end: item.id })
  }
  return ranges
}

/** 将已提交压缩记录的 shadowedRanges 应用到模型面；调用方仍保留完整 facts。 */
export function applyCommittedSurfaceShadow<T extends SurfaceReplayItem>(items: readonly T[], replay: CompactionReplay, requiredIds: readonly string[] = [], windowId?: string, fingerprint?: (items: readonly T[]) => string): T[] {
  // 从当前输出窗口沿 inputWindowId 反向找出同一条窗口链；这样既能排除
  // 不相关分支，又不会在 reset 后误丢掉旧窗口上的 checkpoint。
  const applicable = new Set<string>()
  if (windowId) {
    let activeWindow = windowId
    for (const committed of [...replay.committed].reverse()) {
      const outputWindow = [committed.summary, committed.end].map((event) => event.payload.outputWindowId).find((value): value is string => typeof value === 'string') ?? [committed.end, committed.summary, committed.start].map((event) => event.payload.windowId).find((value): value is string => typeof value === 'string')
      if (outputWindow !== activeWindow) continue
      applicable.add(committed.compactionId)
      activeWindow = (typeof committed.summary.payload.inputWindowId === 'string' ? committed.summary.payload.inputWindowId : undefined) ?? (typeof committed.start.payload.windowId === 'string' ? committed.start.payload.windowId : activeWindow)
    }
  }
  const required = new Set(requiredIds)
  let currentSurface = [...items]
  const initialIdentities = surfaceItemIdentities(items)
  const stableIdentities = new Map(items.map((item, index) => [item.id, initialIdentities[index] ?? surfaceItemIdentity(item, index)]))
  const canonicalizeCurrentSurface = (): void => {
    const checkpointIds = new Set(replay.committed.flatMap((committed) => {
      const candidate = committed.summary.payload.candidate
      const checkpoint = candidate && typeof candidate === 'object' ? (candidate as { checkpointMessage?: unknown }).checkpointMessage : undefined
      const checkpointId = checkpoint && typeof checkpoint === 'object' ? (checkpoint as { id?: unknown }).id : undefined
      return typeof checkpointId === 'string' ? [checkpointId] : []
    }))
    const projection = projectReplaySurfaceWithSources(currentSurface, { mergeAdjacentUsers: (left, right) => {
      const leftId = left && typeof left === 'object' ? (left as { id?: unknown }).id : undefined
      const rightId = right && typeof right === 'object' ? (right as { id?: unknown }).id : undefined
      return (typeof leftId === 'string' && checkpointIds.has(leftId)) || (typeof rightId === 'string' && checkpointIds.has(rightId))
    } })
    const identities = surfaceItemIdentities(projection.messages)
    projection.sourceGroups.forEach((group, index) => {
      for (const source of group) {
        const sourceId = source && typeof source === 'object' ? (source as { id?: unknown }).id : undefined
        if (typeof sourceId === 'string') stableIdentities.set(sourceId, identities[index]!)
      }
    })
  }
  canonicalizeCurrentSurface()
  for (const committed of replay.committed) {
    if (windowId && !applicable.has(committed.compactionId)) continue
    const expectedInput = committed.start.payload.inputSurfaceFingerprint
    const surfaceBeforeRecord = [...currentSurface]
    const ranges = committed.summary.payload.shadowedRanges
    if (!Array.isArray(ranges)) continue
    const persistedBoundary = committed.start.payload.surfaceBoundaryId
    const rangeBoundary = ranges.reduce<string | undefined>((last, range) => {
      if (!range || typeof range !== 'object') return last
      return typeof (range as { end?: unknown }).end === 'string' ? (range as { end: string }).end : last
    }, undefined)
    const expectedBoundaryIndex = fingerprint && typeof expectedInput === 'string'
      ? currentSurface.findIndex((_, index) => fingerprint(currentSurface.slice(0, index + 1)) === expectedInput)
      : -1
    const boundaryEnd = expectedBoundaryIndex >= 0 ? currentSurface[expectedBoundaryIndex]?.id : (typeof persistedBoundary === 'string' ? persistedBoundary : rangeBoundary)
    const currentIdentities = currentSurface.map((item, index) => stableIdentities.get(item.id) ?? surfaceItemIdentity(item, index))
    const boundaryIndex = boundaryEnd ? currentSurface.findIndex((item, index) => item.id === boundaryEnd || currentIdentities[index] === boundaryEnd) : -1
    const inputSurface = boundaryIndex >= 0 ? currentSurface.slice(0, boundaryIndex + 1) : currentSurface
    const historicalIds = new Set(inputSurface.map((item) => item.id))
    if (fingerprint && typeof expectedInput === 'string' && fingerprint(inputSurface) !== expectedInput) continue
    const shadowedIds = new Set<string>()
    let insertionIndex = -1
    for (const range of ranges) {
      if (!range || typeof range !== 'object') { shadowedIds.clear(); break }
      const start = (range as { start?: unknown }).start
      const end = (range as { end?: unknown }).end
      const rangeStart = currentSurface.findIndex((item, index) => item.id === start || currentIdentities[index] === start)
      const rangeEnd = currentSurface.findIndex((item, index) => item.id === end || currentIdentities[index] === end)
      if (rangeStart < 0 || rangeEnd < rangeStart) { shadowedIds.clear(); break }
      if (insertionIndex < 0) insertionIndex = rangeStart
      for (const item of currentSurface.slice(rangeStart, rangeEnd + 1)) shadowedIds.add(item.id)
    }
    if (shadowedIds.size === 0) continue
    currentSurface = currentSurface.filter((item) => !shadowedIds.has(item.id) || item.required || required.has(item.id))
    const candidate = committed.summary.payload.candidate
    const checkpointMessage = candidate && typeof candidate === 'object' ? (candidate as { checkpointMessage?: unknown }).checkpointMessage : undefined
    if (checkpointMessage && typeof checkpointMessage === 'object' && typeof (checkpointMessage as { id?: unknown }).id === 'string') {
      const checkpoint = checkpointMessage as T
      currentSurface.splice(Math.min(insertionIndex, currentSurface.length), 0, checkpoint)
      const replayIdentity = candidate && typeof candidate === 'object' ? (candidate as { checkpointReplayIdentity?: unknown }).checkpointReplayIdentity : undefined
      stableIdentities.set(checkpoint.id, typeof replayIdentity === 'string' ? replayIdentity : surfaceItemIdentity(checkpoint, insertionIndex))
    }
    canonicalizeCurrentSurface()
    const expectedOutput = committed.summary.payload.outputSurfaceFingerprint ?? committed.end.payload.outputSurfaceFingerprint
    const outputSurface = boundaryIndex >= 0 ? currentSurface.filter((item) => historicalIds.has(item.id) || item.id === checkpointMessageId(committed)) : currentSurface
    if (fingerprint && typeof expectedOutput === 'string' && fingerprint(outputSurface) !== expectedOutput) {
      currentSurface = surfaceBeforeRecord
      break
    }
  }
  return currentSurface
}

function replayCanonicalPayload(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value) ?? ''
  const source = value as { role?: unknown; content?: unknown }
  return JSON.stringify({ role: source.role, content: canonicalSurfaceContent(source.role, source.content) })
}

function checkpointMessageId(committed: CompactionReplay['committed'][number]): string | undefined {
  const candidate = committed.summary.payload.candidate
  const checkpoint = candidate && typeof candidate === 'object' ? (candidate as { checkpointMessage?: unknown }).checkpointMessage : undefined
  return checkpoint && typeof checkpoint === 'object' && typeof (checkpoint as { id?: unknown }).id === 'string' ? (checkpoint as { id: string }).id : undefined
}
