export type CompactableItem = { id: string; tokens: number; required: boolean }
export type CompactionRecord = { checkpointId: string; shadowedRanges: Array<{ start: string; end: string }> }
export type ActionResult = { status: 'applied' | 'no-op' | 'uncompressible'; items: CompactableItem[]; facts: CompactableItem[]; record: CompactionRecord }

export function summarizeSurface(items: readonly CompactableItem[], args: { checkpointId: string; checkpointTokens: number }): ActionResult {
  const old = items.filter((item) => !item.required).slice(0, -1)
  if (!old.length || args.checkpointTokens >= old.reduce((sum, item) => sum + item.tokens, 0)) return { status: 'no-op', items: [...items], facts: [...items], record: { checkpointId: args.checkpointId, shadowedRanges: [] } }
  const checkpoint: CompactableItem = { id: args.checkpointId, tokens: Math.max(0, args.checkpointTokens), required: false }
  const tail = items.filter((item) => !old.includes(item))
  return { status: 'applied', items: [checkpoint, ...tail], facts: [...items], record: { checkpointId: args.checkpointId, shadowedRanges: [{ start: old[0]!.id, end: old[old.length - 1]!.id }] } }
}

export function resetSurface(items: readonly CompactableItem[], args: { checkpointId: string; checkpointTokens: number }): ActionResult {
  const retained = items.filter((item) => item.required || item === items[items.length - 1])
  return { status: 'applied', items: [{ id: args.checkpointId, tokens: Math.max(0, args.checkpointTokens), required: false }, ...retained], facts: [...items], record: { checkpointId: args.checkpointId, shadowedRanges: items.filter((item) => !retained.includes(item)).map((item) => ({ start: item.id, end: item.id })) } }
}
