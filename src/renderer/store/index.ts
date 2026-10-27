import { configureStore, type Middleware } from '@reduxjs/toolkit'
import chatReducer from './chatSlice'
import { setSession } from './chatSlice'
import sessionReducer from './sessionSlice'
import configReducer from './configSlice'
import browserDetectReducer from './browserDetectSlice'
import chatLaunchReducer from './chatLaunchSlice'
import { recordRendererSessionSelection } from '../services/sessionSwitchTrace'

type SessionSelectionState = { chat: ReturnType<typeof chatReducer> }

const sessionSelectionTraceMiddleware: Middleware<{}, SessionSelectionState> = ({ getState }) => (next) => (action) => {
  if (setSession.match(action)) {
    recordRendererSessionSelection(action.payload, getState().chat.currentSessionId)
  }
  return next(action)
}

export const store = configureStore({
  reducer: {
    chat: chatReducer,
    session: sessionReducer,
    config: configReducer,
    browserDetect: browserDetectReducer,
    chatLaunch: chatLaunchReducer
  },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(sessionSelectionTraceMiddleware)
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
