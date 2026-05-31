import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { ChatLaunchIntent } from '../../shared/domainTypes'

export type ChatLaunchState = {
  intent: (ChatLaunchIntent & { sessionId: string }) | null
}

const initialState: ChatLaunchState = {
  intent: null
}

const chatLaunchSlice = createSlice({
  name: 'chatLaunch',
  initialState,
  reducers: {
    setChatLaunchIntent(state, action: PayloadAction<ChatLaunchIntent & { sessionId: string }>) {
      state.intent = action.payload
    },
    clearChatLaunchIntent(state) {
      state.intent = null
    }
  }
})

export const { setChatLaunchIntent, clearChatLaunchIntent } = chatLaunchSlice.actions
export default chatLaunchSlice.reducer
