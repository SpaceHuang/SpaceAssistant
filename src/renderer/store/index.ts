import { configureStore } from '@reduxjs/toolkit'
import chatReducer from './chatSlice'
import sessionReducer from './sessionSlice'
import configReducer from './configSlice'
import browserDetectReducer from './browserDetectSlice'
import chatLaunchReducer from './chatLaunchSlice'

export const store = configureStore({
  reducer: {
    chat: chatReducer,
    session: sessionReducer,
    config: configReducer,
    browserDetect: browserDetectReducer,
    chatLaunch: chatLaunchReducer
  }
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
