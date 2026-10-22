/** Turn state vocabulary shared by lifecycle decisions and generated SQL guards. */
export const ACTIVE_TURN_STATES = ['configuring', 'prepared', 'executing', 'waiting-confirm', 'running'] as const
export const TERMINAL_TURN_STATES = ['terminal', 'completed', 'failed', 'cancelled', 'interrupted'] as const
export const TURN_STATES = [...ACTIVE_TURN_STATES, ...TERMINAL_TURN_STATES] as const
export type TurnState = typeof TURN_STATES[number]

/** Unknown persisted states stay protected as active until an owner explicitly retires them. */
export function isActiveTurnState(state: string): boolean {
  return !(TERMINAL_TURN_STATES as readonly string[]).includes(state)
}

/** SQL counterpart of isActiveTurnState; unknown legacy values remain fail-closed. */
export function sqlActiveTurnPredicate(column = 'state'): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(column)) throw new Error('TURN_STATE_SQL_COLUMN_INVALID')
  return `(${column} IS NULL OR ${column} NOT IN (${TERMINAL_TURN_STATES.map((state) => `'${state}'`).join(',')}))`
}
