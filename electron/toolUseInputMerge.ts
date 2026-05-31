/**
 * 合并流式组装的 tool_use.input 与 finalMessage() 返回的 input，
 * 避免网关/SDK 侧 input 不完整或序列化为字符串时导致校验失败。
 */

export function normalizeToolUseInputRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>) }
  }
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (!t) return {}
    try {
      const p = JSON.parse(t) as unknown
      if (p && typeof p === 'object' && !Array.isArray(p)) return p as Record<string, unknown>
    } catch {
      /* ignore */
    }
  }
  return {}
}

function indexToolUseInputsById(blocks: unknown[]): Map<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>()
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if ((b as { type?: string }).type !== 'tool_use') continue
    const id = (b as { id?: unknown }).id
    if (typeof id !== 'string' || !id) continue
    m.set(id, normalizeToolUseInputRecord((b as { input?: unknown }).input))
  }
  return m
}

function coalesceToolUseInputs(
  toolName: string,
  streamed: Record<string, unknown>,
  final: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...streamed, ...final }
  const ensureString = (...keys: string[]) => {
    for (const key of keys) {
      if (typeof merged[key] !== 'string') {
        if (typeof streamed[key] === 'string') merged[key] = streamed[key]
        else if (typeof final[key] === 'string') merged[key] = final[key]
      }
    }
  }
  if (toolName === 'write_file') ensureString('path', 'content')
  else if (toolName === 'edit_file') ensureString('path', 'old_string', 'new_string')
  else if (toolName === 'run_script') ensureString('code')
  else if (toolName === 'run_shell') ensureString('command')
  else if (toolName === 'grep') ensureString('pattern', 'path', 'glob')
  return merged
}

export function mergeStreamedToolInputsIntoContent(content: unknown[], streamedBlocks: unknown[]): unknown[] {
  const byId = indexToolUseInputsById(streamedBlocks)
  return content.map((b) => {
    if (!b || typeof b !== 'object' || (b as { type?: string }).type !== 'tool_use') return b
    const id = (b as { id?: unknown }).id
    const name = (b as { name?: unknown }).name
    if (typeof id !== 'string' || typeof name !== 'string') return b
    const streamed = byId.get(id) ?? {}
    const final = normalizeToolUseInputRecord((b as { input?: unknown }).input)
    const input = coalesceToolUseInputs(name, streamed, final)
    return { ...(b as object), input }
  })
}
