import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { Session } from '../../shared/domainTypes'

interface SessionState {
  list: Session[]
  loading: boolean
}

const initialState: SessionState = {
  list: [],
  loading: false
}

export const sessionSlice = createSlice({
  name: 'session',
  initialState,
  reducers: {
    setSessions(state, action: PayloadAction<Session[]>) {
      state.list = action.payload
    },
    setLoading(state, action: PayloadAction<boolean>) {
      state.loading = action.payload
    },
    upsertSession(state, action: PayloadAction<Session>) {
      const i = state.list.findIndex((s) => s.id === action.payload.id)
      if (i >= 0) state.list[i] = action.payload
      else state.list.unshift(action.payload)
    },
    removeSession(state, action: PayloadAction<string>) {
      state.list = state.list.filter((s) => s.id !== action.payload)
    }
  }
})

export const { setSessions, setLoading, upsertSession, removeSession } = sessionSlice.actions
export default sessionSlice.reducer
