import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { AppConfig } from '../../shared/domainTypes'

interface ConfigState {
  config: AppConfig | null
  settingsOpen: boolean
  settingsActiveTab?: string
  aboutOpen: boolean
}

const initialState: ConfigState = {
  config: null,
  settingsOpen: false,
  settingsActiveTab: undefined,
  aboutOpen: false
}

export const configSlice = createSlice({
  name: 'config',
  initialState,
  reducers: {
    setConfig(state, action: PayloadAction<AppConfig | null>) {
      state.config = action.payload
    },
    setSettingsOpen(state, action: PayloadAction<boolean>) {
      state.settingsOpen = action.payload
      if (!action.payload) {
        state.settingsActiveTab = undefined
      }
    },
    openSettings(state, action: PayloadAction<{ tab?: string } | undefined>) {
      state.settingsOpen = true
      if (action.payload?.tab) {
        state.settingsActiveTab = action.payload.tab
      }
    },
    setSettingsActiveTab(state, action: PayloadAction<string | undefined>) {
      state.settingsActiveTab = action.payload
    },
    setAboutOpen(state, action: PayloadAction<boolean>) {
      state.aboutOpen = action.payload
    }
  }
})

export const { setConfig, setSettingsOpen, openSettings, setSettingsActiveTab, setAboutOpen } = configSlice.actions
export default configSlice.reducer
