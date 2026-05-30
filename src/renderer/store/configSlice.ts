import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { AppConfig } from '../../shared/domainTypes'

export type ToolsSettingsSubTab = 'switches' | 'file' | 'script' | 'browser'

interface ConfigState {
  config: AppConfig | null
  settingsOpen: boolean
  settingsActiveTab?: string
  settingsToolsSubTab?: ToolsSettingsSubTab
  aboutOpen: boolean
}

const initialState: ConfigState = {
  config: null,
  settingsOpen: false,
  settingsActiveTab: undefined,
  settingsToolsSubTab: undefined,
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
        state.settingsToolsSubTab = undefined
      }
    },
    openSettings(
      state,
      action: PayloadAction<{ tab?: string; toolsSubTab?: ToolsSettingsSubTab } | undefined>
    ) {
      state.settingsOpen = true
      if (action.payload?.tab) {
        state.settingsActiveTab = action.payload.tab
      }
      if (action.payload?.toolsSubTab) {
        state.settingsToolsSubTab = action.payload.toolsSubTab
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
