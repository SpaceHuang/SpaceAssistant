import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { isActiveTurnState, sqlActiveTurnPredicate, TURN_STATES } from './turnState'

describe('turn state specification', () => {
  it('shares active and terminal vocabulary and conservatively protects unknown states', () => {
    expect(TURN_STATES.filter(isActiveTurnState)).toEqual(['configuring', 'prepared', 'executing', 'waiting-confirm', 'running'])
    expect(TURN_STATES.filter((state) => !isActiveTurnState(state))).toEqual(['terminal', 'completed', 'failed', 'cancelled', 'interrupted'])
    expect(isActiveTurnState('future-legacy-state')).toBe(true)
    expect(sqlActiveTurnPredicate('turn.state')).toBe("(turn.state IS NULL OR turn.state NOT IN ('terminal','completed','failed','cancelled','interrupted'))")
    expect(() => sqlActiveTurnPredicate('state) OR 1=1 --')).toThrow('TURN_STATE_SQL_COLUMN_INVALID')
  })

  it('random state sequences keep the domain rule and SQLite guard equivalent', () => {
    const conn = new DatabaseSync(':memory:')
    try {
      conn.exec('CREATE TABLE turn_state_probe (state TEXT)')
      const states: Array<string | null> = [...TURN_STATES, 'future-v3-state', '', null]
      let seed = 0x5eed1234
      const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed }
      for (let index = 0; index < 250; index += 1) {
        const state = states[random() % states.length]!
        conn.prepare('DELETE FROM turn_state_probe').run()
        conn.prepare('INSERT INTO turn_state_probe(state) VALUES(?)').run(state)
        const row = conn.prepare(`SELECT ${sqlActiveTurnPredicate('state')} AS active FROM turn_state_probe`).get() as { active: number }
        expect(Boolean(row.active)).toBe(isActiveTurnState(state))
      }
      const sequence = Array.from({ length: 100 }, () => states[random() % states.length]!)
      expect(sequence.map(isActiveTurnState)).toEqual(sequence.map((state) => {
        conn.prepare('DELETE FROM turn_state_probe').run()
        conn.prepare('INSERT INTO turn_state_probe(state) VALUES(?)').run(state)
        return Boolean((conn.prepare(`SELECT ${sqlActiveTurnPredicate('state')} AS active FROM turn_state_probe`).get() as { active: number }).active)
      }))
    } finally {
      conn.close()
    }
  })
})
