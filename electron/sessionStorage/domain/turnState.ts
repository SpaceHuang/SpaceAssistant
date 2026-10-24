/** Persisted turns have active lifecycle states plus terminal/outcome rows and legacy terminal states. */
export const ACTIVE_TURN_STATES = ['configuring', 'prepared', 'executing', 'waiting-confirm'] as const
export const LEGACY_TERMINAL_TURN_STATES = ['completed', 'failed', 'cancelled', 'interrupted'] as const
export const TURN_STATES = [...ACTIVE_TURN_STATES, 'terminal', ...LEGACY_TERMINAL_TURN_STATES] as const
export type TurnState = typeof TURN_STATES[number]

export function isActiveTurnState(state: string): boolean {
  return (ACTIVE_TURN_STATES as readonly string[]).includes(state)
}

export function sqlActiveTurnPredicate(column = 'state'): string {
  return `${column} IN (${ACTIVE_TURN_STATES.map((state) => `'${state}'`).join(',')})`
}
