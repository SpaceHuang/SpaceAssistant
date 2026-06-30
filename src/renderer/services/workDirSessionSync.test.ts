import { describe, expect, it, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import configReducer from '../store/configSlice'
import sessionReducer from '../store/sessionSlice'
import { ensureWorkDirForSession, sessionNeedsWorkDirSwitch } from './workDirSessionSync'
import type { Session } from '../../shared/domainTypes'

const session: Session = {
  id: 's1',
  name: 'Test',
  preview: '',
  model: 'm',
  temperature: 1,
  maxTokens: 1024,
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
  workDirProfileId: 'p2',
  schemaVersion: 1
}

const config = {
  workDir: '/a',
  workDirProfiles: [
    { id: 'p1', name: 'A', path: '/a', isDefault: true },
    { id: 'p2', name: 'B', path: '/b' }
  ],
  activeWorkDirProfileId: 'p1'
} as const

describe('workDirSessionSync', () => {
  beforeEach(() => {
    vi.stubGlobal('api', {
      workdirSwitch: vi.fn().mockResolvedValue({ success: true, sessions: [] }),
      configGet: vi.fn().mockResolvedValue(config)
    })
  })

  it('sessionNeedsWorkDirSwitch detects profile mismatch', () => {
    expect(sessionNeedsWorkDirSwitch(session, config as never)).toBe(true)
    expect(
      sessionNeedsWorkDirSwitch({ ...session, workDirProfileId: 'p1' }, config as never)
    ).toBe(false)
  })

  it('ensureWorkDirForSession switches profile and updates store', async () => {
    const store = configureStore({
      reducer: { config: configReducer, session: sessionReducer },
      preloadedState: {
        config: { config: config as never, settingsOpen: false, aboutOpen: false },
        session: { list: [], loading: false }
      } as never
    })

    const result = await ensureWorkDirForSession(session, config as never, store.dispatch)
    expect(result).toEqual({ ok: true, switched: true })
    expect(window.api.workdirSwitch).toHaveBeenCalledWith('p2')
  })
})
