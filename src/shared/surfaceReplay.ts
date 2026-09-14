import type { CompactionReplay } from './compactionEvents'
import { buildRequestHeaderPayload } from './requestContext'

export type SurfaceReplayItem = { id: string; required?: boolean }

/** 将 provider 的 assistant content blocks 投影成数据库持久化的正文表示。 */
export function canonicalSurfaceContent(role: unknown, content: unknown): unknown {
  if (role !== 'assistant' || !Array.isArray(content)) return content
  return content
    .filter((block): block is { type?: unknown; text?: unknown } => Boolean(block) && typeof block === 'object')
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** 将工具协议消息投影为可由数据库稳定重建的 turn surface。 */
export function projectReplaySurface<T>(messages: readonly T[]): T[] {
  const projected: T[] = []
  let toolTurnAssistantIndex = -1
  for (const message of messages) {
    if (!message || typeof message !== 'object') { projected.push(message); continue }
    const source = message as { role?: unknown; content?: unknown }
    if (source.role === 'user' && Array.isArray(source.content)) {
      if (source.content.every((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_result')) continue
    }
    if (source.role === 'assistant' && Array.isArray(source.content)) {
      const hasToolUse = source.content.some((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_use')
      const text = canonicalSurfaceContent(source.role, source.content)
      if (hasToolUse) {
        // 空正文的 tool-use assistant 仍是一个可持久化的轮次锚点；否则 reset
        // 删除历史工具对后，projection 前后看起来完全相同，压缩范围无法回放。
        if (toolTurnAssistantIndex < 0) {
          projected.push({ ...(message as object), content: typeof text === 'string' ? text : '' } as T)
          toolTurnAssistantIndex = projected.length - 1
        } else if (typeof text === 'string' && text.length > 0) {
          const previous = projected[toolTurnAssistantIndex] as unknown as { content?: unknown }
          projected[toolTurnAssistantIndex] = { ...(previous as object), content: `${typeof previous.content === 'string' ? previous.content : ''}${text}` } as T
        }
        continue
      }
      if (toolTurnAssistantIndex >= 0 && typeof text === 'string') {
        const previous = projected[toolTurnAssistantIndex] as unknown as { content?: unknown }
        projected[toolTurnAssistantIndex] = { ...(previous as object), content: `${typeof previous.content === 'string' ? previous.content : ''}${text}` } as T
        toolTurnAssistantIndex = -1
        continue
      }
    }
    if (source.role === 'user') toolTurnAssistantIndex = -1
    projected.push(source.role === 'assistant' ? { ...(message as object), content: canonicalSurfaceContent(source.role, source.content) } as T : message)
  }
  return projected
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

export function computeReplaySurfaceFingerprint(system: string, surface: readonly unknown[]): string {
  // replay 指纹描述历史消息，不应受每轮动态 system prompt 影响。
  void system
  return buildRequestHeaderPayload({ requestId: 'replay', system: '', tools: [], messages: surface.map((message) => {
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
    const expectedOutput = committed.summary.payload.outputSurfaceFingerprint ?? committed.end.payload.outputSurfaceFingerprint
    const outputSurface = boundaryIndex >= 0 ? currentSurface.filter((item) => historicalIds.has(item.id) || item.id === checkpointMessageId(committed)) : currentSurface
    if (fingerprint && typeof expectedOutput === 'string' && fingerprint(outputSurface) !== expectedOutput) {
      currentSurface = surfaceBeforeRecord
      break
    }
  }
  return currentSurface
}

function checkpointMessageId(committed: CompactionReplay['committed'][number]): string | undefined {
  const candidate = committed.summary.payload.candidate
  const checkpoint = candidate && typeof candidate === 'object' ? (candidate as { checkpointMessage?: unknown }).checkpointMessage : undefined
  return checkpoint && typeof checkpoint === 'object' && typeof (checkpoint as { id?: unknown }).id === 'string' ? (checkpoint as { id: string }).id : undefined
}
