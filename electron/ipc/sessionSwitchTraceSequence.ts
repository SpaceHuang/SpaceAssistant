export function createSessionSwitchRequestSequence(): (sender: object, processId: number) => number {
  const sequenceBySender = new WeakMap<object, { processId: number; ordinal: number }>()
  return (sender, processId) => {
    if (!Number.isSafeInteger(processId) || processId < 0) throw new Error('SESSION_SWITCH_RENDERER_PROCESS_ID_INVALID')
    const previous = sequenceBySender.get(sender)
    const ordinal = previous?.processId === processId ? previous.ordinal + 1 : 1
    if (!Number.isSafeInteger(ordinal)) throw new Error('SESSION_SWITCH_REQUEST_ORDINAL_EXHAUSTED')
    sequenceBySender.set(sender, { processId, ordinal })
    return ordinal
  }
}
